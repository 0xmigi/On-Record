import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema, logger, fetchVerifyRequests, type Network } from "@onrecord/core";
import { checkVerification } from "@onrecord/enrich";
import { fetchVerifiedProgramIds } from "./backfill-verified.js";

// ---------------------------------------------------------------------------
// Verified-build sweep.
//
// The pipeline asks OtterSec whether a build is verified exactly once, inside
// identify, which only runs on a deploy/upgrade event. That is the one moment
// the answer is guaranteed to be "no": nobody can reproduce bytecode that is
// not on chain yet, so verification is ALWAYS a later act than the deploy it
// describes. Measured 2026-08-10 against the registry: 38 of the 482 verified
// programs in the corpus were stuck at verified=false purely because they were
// verified after their last upgrade. The Solana Foundation's subscriptions
// program missed by 30 minutes.
//
// So the flag needs re-asking on a clock, and in BOTH directions:
//
//  - false → true: verification landed after we last looked.
//  - true → false: the program was upgraded after being verified, so the
//    deployed hash no longer matches the published source. 81 of the programs
//    listed in the registry are in exactly this state — registry membership
//    means "was verified once", not "is verified now", which is why this reads
//    /status per program instead of trusting the list.
//
// Candidates are the registry ∩ the corpus, plus anything we currently show as
// verified (so a program that drops off the registry entirely still gets
// corrected). Stamped per program and capped per pass, like the repo sweeps.
// ---------------------------------------------------------------------------

/** Programs re-checked per pass. At the 6h cadence this covers ~1000/day
 *  against a candidate set of ~490 — comfortable headroom as the registry
 *  grows, without hammering the API. */
const VERIFY_MAX = Number(process.env.VERIFY_SWEEP_MAX ?? 250);
/** Don't re-ask about the same program more often than this. Weekly, because
 *  the fast path below now catches new verifications within the hour — this
 *  sweep is the backstop for what the fast path structurally cannot see, not
 *  the primary mechanism. */
const RECHECK_HOURS = Number(process.env.VERIFY_RECHECK_HOURS ?? 168);

export interface VerifySweepResult {
  checked: number;
  /** newly verified — the case the pipeline structurally cannot catch */
  gained: number;
  /** verification lost, normally an upgrade past the verified commit */
  lost: number;
  skipped?: "no-registry" | "no-eligible-rows";
}

export async function sweepVerification(network: Network = "mainnet"): Promise<VerifySweepResult> {
  // verified builds are a mainnet registry concept; devnet has none
  if (network === "devnet") return { checked: 0, gained: 0, lost: 0, skipped: "no-registry" };

  let registry: string[];
  try {
    registry = await fetchVerifiedProgramIds();
  } catch (err) {
    logger.warn({ err: String(err) }, "verify-sweep: registry fetch failed");
    return { checked: 0, gained: 0, lost: 0, skipped: "no-registry" };
  }
  if (!registry.length) return { checked: 0, gained: 0, lost: 0, skipped: "no-registry" };

  const rows = await db
    .select({
      id: schema.subjects.id,
      verified: schema.subjects.verified,
      repoUrl: schema.subjects.repoUrl,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, network),
        // only these can change: a program the registry has never heard of
        // cannot become verified, and one we already show verified must stay
        // answerable even after it falls off the list
        or(inArray(schema.subjects.id, registry), eq(schema.subjects.verified, true)),
        sql`(${schema.subjects.facts}->>'verifiedCheckedAt' is null
             or (${schema.subjects.facts}->>'verifiedCheckedAt')::timestamptz
                < now() - ${`${RECHECK_HOURS} hours`}::interval)`,
      ),
    )
    // never-checked first, then oldest check
    .orderBy(sql`${schema.subjects.facts}->>'verifiedCheckedAt' asc nulls first`)
    .limit(VERIFY_MAX);

  if (!rows.length) {
    return { checked: 0, gained: 0, lost: 0, skipped: "no-eligible-rows" };
  }

  let gained = 0;
  let lost = 0;
  let checked = 0;

  for (const row of rows) {
    // bust the cache: the in-process one is keyed per program and this sweep is
    // the only thing that would ever be reading its own stale write
    const v = await checkVerification(row.id, { bustCache: true });
    checked++;

    const flipped = v.verified !== Boolean(row.verified);
    if (flipped) v.verified ? gained++ : lost++;

    // A verified build names the repo it was built from — the strongest repo
    // claim available, so take it. Do NOT clear repoUrl when verification is
    // lost: what is left is the developer's own security.txt/bytecode
    // declaration, which is still a declaration, just no longer corroborated.
    const takesRepo = v.verified && Boolean(v.repoUrl) && v.repoUrl !== row.repoUrl;

    await db
      .update(schema.subjects)
      .set({
        verified: v.verified,
        ...(takesRepo ? { repoUrl: v.repoUrl, repoCommit: v.commit } : {}),
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({
          verifiedCheckedAt: new Date().toISOString(),
          // a fresh repo URL invalidates whatever the liveness sweep concluded
          // about the old one — let it re-ask rather than inherit a dead flag
          ...(takesRepo ? { repoUrlCheckedAt: null, repoUrlDead: null, repoUrlRoot: null } : {}),
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.subjects.id, row.id), eq(schema.subjects.network, network)));

    if (flipped) {
      logger.info(
        { programId: row.id, verified: v.verified, repoUrl: v.repoUrl, commit: v.commit },
        v.verified ? "verified build gained" : "verified build lost",
      );
    }
  }

  const result = { checked, gained, lost };
  logger.info({ network, ...result, candidates: rows.length }, "verify sweep");
  return result;
}

// ---------------------------------------------------------------------------
// Fast path.
//
// A program that just deployed AND has an on-chain verification request is the
// only kind that is about to become verified. Measured across 43 verified
// programs, the answer lands a median of 17 minutes after the request appears,
// about half of them inside an hour. So instead of waiting up to a week for the
// sweep above, enroll those programs on a short decaying ladder and stop as
// soon as they answer.
//
// The request set costs ONE RPC call for all ~1,100 programs (cached 10m), so
// the filter is effectively free — and it is what keeps this cheap: without it
// this would be "re-poll every recent deploy", which is most of the corpus.
//
// Enrollment resets when a program deploys again, so an upgrade that re-triggers
// verification gets a fresh ladder rather than staying parked.
// ---------------------------------------------------------------------------

/** Delay before each successive attempt. Front-loaded around the 17-minute
 *  median, then backing off to a day; after the last one the weekly sweep owns
 *  the program again. */
const LADDER_MINUTES = [20, 60, 6 * 60, 24 * 60];
/** Only enroll programs that deployed recently — an old program with a stale
 *  failed request is not about to flip, and the weekly sweep still covers it. */
const ENROLL_WINDOW_DAYS = Number(process.env.VERIFY_FAST_WINDOW_DAYS ?? 7);
const FAST_MAX = Number(process.env.VERIFY_FAST_MAX ?? 60);

export interface FastPathResult {
  checked: number;
  gained: number;
  pending: number;
  skipped?: "no-requests" | "no-eligible-rows";
}

export async function sweepVerifyPending(network: Network = "mainnet"): Promise<FastPathResult> {
  if (network === "devnet") return { checked: 0, gained: 0, pending: 0, skipped: "no-requests" };

  // one call, whole set. An empty result means the lookup failed or the program
  // moved — treat it as "unknown" and do nothing rather than enrolling the corpus.
  const requested = await fetchVerifyRequests(network);
  if (!requested.size) return { checked: 0, gained: 0, pending: 0, skipped: "no-requests" };

  const rows = await db
    .select({
      id: schema.subjects.id,
      repoUrl: schema.subjects.repoUrl,
      attempts: sql<number>`coalesce((${schema.subjects.facts}->>'verifyAttempts')::int, 0)`,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, network),
        eq(schema.subjects.verified, false),
        inArray(schema.subjects.id, [...requested]),
        sql`(
          -- a rung of the ladder has come due
          (${schema.subjects.facts}->>'verifyNextCheckAt' is not null
           and (${schema.subjects.facts}->>'verifyNextCheckAt')::timestamptz <= now())
          or
          -- never enrolled, or deployed again since we last ran the ladder
          (${schema.subjects.lastEventAt} > now() - ${`${ENROLL_WINDOW_DAYS} days`}::interval
           and (${schema.subjects.facts}->>'verifyFastAt' is null
                or (${schema.subjects.facts}->>'verifyFastAt')::timestamptz < ${schema.subjects.lastEventAt}))
        )`,
      ),
    )
    .orderBy(sql`${schema.subjects.lastEventAt} desc nulls last`)
    .limit(FAST_MAX);

  if (!rows.length) return { checked: 0, gained: 0, pending: 0, skipped: "no-eligible-rows" };

  let gained = 0;
  let pending = 0;

  for (const row of rows) {
    const v = await checkVerification(row.id, { bustCache: true });
    const attempt = Number(row.attempts) || 0;

    // exhausted rungs park the program: null next-check stops the ladder, and
    // verifyFastAt only clears on a NEW deploy, so it won't re-enroll on its own
    const nextDelay = v.verified ? null : (LADDER_MINUTES[attempt] ?? null);
    const takesRepo = v.verified && Boolean(v.repoUrl) && v.repoUrl !== row.repoUrl;
    if (v.verified) gained++;
    else if (nextDelay !== null) pending++;

    await db
      .update(schema.subjects)
      .set({
        verified: v.verified,
        ...(takesRepo ? { repoUrl: v.repoUrl, repoCommit: v.commit } : {}),
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({
          verifyFastAt: new Date().toISOString(),
          verifyAttempts: v.verified ? null : attempt + 1,
          verifyNextCheckAt:
            nextDelay === null ? null : new Date(Date.now() + nextDelay * 60_000).toISOString(),
          // a resolved program is current as of now — let the weekly sweep skip it
          ...(v.verified ? { verifiedCheckedAt: new Date().toISOString() } : {}),
          ...(takesRepo ? { repoUrlCheckedAt: null, repoUrlDead: null, repoUrlRoot: null } : {}),
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.subjects.id, row.id), eq(schema.subjects.network, network)));

    if (v.verified) {
      logger.info(
        { programId: row.id, repoUrl: v.repoUrl, commit: v.commit, attempt: attempt + 1 },
        "verified build gained (fast path)",
      );
    }
  }

  const result = { checked: rows.length, gained, pending };
  logger.info({ network, ...result, requests: requested.size }, "verify fast-path sweep");
  return result;
}

// run as a script: tsx src/verify-sweep.ts [--network=mainnet]
const isMain =
  process.argv[1]?.endsWith("verify-sweep.ts") || process.argv[1]?.endsWith("verify-sweep.js");
if (isMain) {
  const arg = (k: string, d: string) =>
    process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
  const network: Network = arg("network", "mainnet") === "devnet" ? "devnet" : "mainnet";
  sweepVerification(network)
    .then((r) => {
      logger.info(r, "verify sweep complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "verify sweep failed");
      process.exit(1);
    });
}
