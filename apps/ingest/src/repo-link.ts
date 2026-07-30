import { and, eq, sql } from "drizzle-orm";
import { db, schema, logger, searchRepoByProgramId, env, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Repo-link sweep: find the source repo for programs that declared none, by
// searching public code for the program id (core/identity.ts).
//
// Deliberately NOT in the pipeline. Two reasons:
//
//  1. Most deploys are bot churn — redeploy, spam, close, repeat — and the
//     closed sweep only learns that minutes later. Searching at identify time
//     spends the budget on programs that no longer exist. Waiting an hour and
//     skipping anything already closed drops nearly all of it.
//  2. Code search allows ~10 requests/minute. The whole deploy stream cannot
//     fit through that; what survives the clone gate can.
//
// So: not a clone, still alive, no repo from any other source, an hour old.
// Misses are stamped too (repoLinkCheckedAt) — a program with no public source
// has none on the next pass either, and re-asking every hour would burn the
// budget on permanent negatives. The stamp expires, because a repo published
// next week is still worth finding.
// ---------------------------------------------------------------------------

const SWEEP_MAX = Number(process.env.REPO_LINK_SWEEP_MAX ?? 40);
/** Give the closed sweep time to mark bot churn before we spend a search. */
const MIN_AGE_HOURS = Number(process.env.REPO_LINK_MIN_AGE_HOURS ?? 1);
/** How far back to keep looking — a program's repo may appear after its deploy. */
const LOOKBACK_DAYS = Number(process.env.REPO_LINK_LOOKBACK_DAYS ?? 14);
/** Re-ask about a program with no repo this often, not every pass. */
const RECHECK_HOURS = Number(process.env.REPO_LINK_RECHECK_HOURS ?? 72);

export interface SweepResult {
  checked: number;
  linked: number;
  /** why nothing happened, when nothing happened */
  skipped?: "no-token" | "no-eligible-rows";
}

// ---------------------------------------------------------------------------
// Liveness of a DECLARED repo.
//
// repoUrl is whatever the project pointed at — a verified build's registry
// entry, the `source_code` field of an embedded security.txt, or a GitHub URL
// left in the binary. None of that is checked, and RianGlas is why it should
// be: its on-chain security.txt declares github.com/guestleba/rianglas-landing,
// which 404s. The dossier was rendering that as "Source code", the radar as a
// repo icon, and the disclosure score was counting it — a project got credit
// for publishing source that nobody can read.
//
// A declared-but-dead pointer is still a fact worth keeping (they DID publish
// it, on chain, and it broke), so nothing is deleted. The serializer just stops
// handing it back as `repoUrl` and returns it as `repoUrlDeclared` instead,
// which no existing consumer treats as a working link.
// ---------------------------------------------------------------------------

/** Bounded per run — this is politeness to other people's servers, not a queue. */
const LIVENESS_MAX = Number(process.env.REPO_LIVENESS_MAX ?? 60);
/** A repo can be deleted, or restored, at any time — re-ask on a slow cycle. */
const LIVENESS_RECHECK_DAYS = Number(process.env.REPO_LIVENESS_RECHECK_DAYS ?? 14);
const LIVENESS_TIMEOUT_MS = 8000;

/** live = reachable · dead = gone · stale = the deep link rotted but the repo
 *  it points into is still there · unknown = we could not tell.
 *
 *  Only 404/410 count against a URL. A timeout, a 5xx or a refused connection
 *  says something about the moment, not the repo, and marking those dead would
 *  strip real source links off the site every time a host had a bad minute. */
export type UrlState = "live" | "stale" | "dead" | "unknown";

/** One request, following redirects. null = no answer, not "no such page". */
async function probe(url: string): Promise<boolean | null> {
  const ask = async (method: "HEAD" | "GET"): Promise<Response | null> => {
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
        headers: { "user-agent": "on-record (+https://on-record.azuolas.xyz)" },
      });
    } catch {
      return null;
    }
  };
  let res = await ask("HEAD");
  // plenty of hosts refuse HEAD outright; that is not an answer about the URL
  if (res && (res.status === 405 || res.status === 501)) res = await ask("GET");
  if (!res) return null;
  if (res.status === 404 || res.status === 410) return false;
  if (res.ok || res.status < 400) return true;
  return null; // 401/403/429/5xx — unreachable to us, not proof of absence
}

/** The repository a deep link points into: `owner/name` on a forge, else the
 *  origin. Verified-build URLs pin a commit (`/tree/<sha>`) and projects force-
 *  push, so the pinned path outlives itself constantly — ripstr-dev's is already
 *  gone while the repo was pushed to this morning. That is a stale pin, not an
 *  absent project, and the two must not share a verdict. */
function repoRootOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  // `owner/name` IS the repo — there is nothing shallower to fall back to, and
  // falling back to the origin would ask github.com whether github.com exists
  // and call every deleted repo "stale". Only a deeper path has a root above it.
  if (parts.length <= 2) return null;
  return `${u.origin}/${parts[0]}/${parts[1]}`;
}

export async function checkRepoUrl(url: string): Promise<{ state: UrlState; root?: string }> {
  if (!/^https?:\/\//i.test(url)) return { state: "unknown" };
  const direct = await probe(url);
  if (direct === true) return { state: "live" };
  if (direct === null) return { state: "unknown" };

  const root = repoRootOf(url);
  if (!root) return { state: "dead" };
  const rootLive = await probe(root);
  if (rootLive === true) return { state: "stale", root };
  if (rootLive === null) return { state: "unknown" }; // couldn't confirm either way
  return { state: "dead" };
}

/** Check declared repo URLs and record which ones are gone. */
export async function sweepRepoLiveness(network: Network = "mainnet"): Promise<{
  checked: number;
  dead: number;
  stale: number;
}> {
  const rows = await db
    .select({ id: schema.subjects.id, repoUrl: schema.subjects.repoUrl })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, network),
        // not just non-null: the corpus holds empty-string repo_url rows (a
        // registry lookup that came back blank, kept because `??` only falls
        // through on null). The serializer already drops them via httpUrl(),
        // but they would eat this sweep's whole budget asking about "".
        sql`${schema.subjects.repoUrl} ~ '^https?://'`,
        sql`(${schema.subjects.facts}->>'repoUrlCheckedAt' is null
             or (${schema.subjects.facts}->>'repoUrlCheckedAt')::timestamptz
                < now() - ${`${LIVENESS_RECHECK_DAYS} days`}::interval)`,
      ),
    )
    // never-checked first, then oldest check
    .orderBy(sql`${schema.subjects.facts}->>'repoUrlCheckedAt' asc nulls first`)
    .limit(LIVENESS_MAX);

  let dead = 0;
  let stale = 0;
  for (const row of rows) {
    const { state, root } = await checkRepoUrl(row.repoUrl!);
    if (state === "unknown") continue; // no answer — don't stamp, ask again next pass
    if (state === "dead") dead++;
    if (state === "stale") stale++;
    await db
      .update(schema.subjects)
      .set({
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({
          repoUrlCheckedAt: new Date().toISOString(),
          repoUrlDead: state === "dead",
          // a stale pin still has readable source at the repo root — serve that
          // rather than a link that 404s, and rather than nothing
          repoUrlRoot: state === "stale" ? root : null,
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.subjects.id, row.id), eq(schema.subjects.network, network)));
    if (state !== "live") {
      logger.info({ programId: row.id, repoUrl: row.repoUrl, state, root }, "declared repo unreachable");
    }
  }

  logger.info({ network, checked: rows.length, dead, stale }, "repo liveness sweep");
  return { checked: rows.length, dead, stale };
}

/** Search for one program's repo and record the outcome — hit or miss. Used by
 *  the sweep and by the admin lever, which forces a single program. */
export async function linkOne(
  programId: string,
  crate: string | null,
  network: Network = "mainnet",
  bustCache = false,
) {
  const link = await searchRepoByProgramId(programId, { crateName: crate, bustCache });
  const patch: Record<string, unknown> = { repoLinkCheckedAt: new Date().toISOString() };
  if (link) patch.repoLink = link;
  await db
    .update(schema.subjects)
    .set({
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.network, network)));
  return link;
}

export async function sweepRepoLinks(network: Network = "mainnet"): Promise<SweepResult> {
  if (!env.GITHUB_TOKEN) return { checked: 0, linked: 0, skipped: "no-token" };

  const rows = await db
    .select({ id: schema.subjects.id, crate: schema.subjects.crate })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, network),
        // Everything but clones. `novel` alone was too tight: a program that
        // resembles something in the corpus is still somebody's real project —
        // Shyft, and both corsur programs, all land in `variant`, and those are
        // precisely the ones with a public repo. Clones are the factory output
        // this is pointless for.
        sql`${schema.subjects.noveltyBand} in ('novel', 'variant')`,
        // Nobody declared one: no verified build, no security.txt, no URL in
        // the binary — upsertSubject collapses all three into repoUrl.
        //
        // Empty string counts as "none". 3,012 of the corpus's 3,464 non-null
        // repo_url values are `''` — a registry lookup that came back blank,
        // preserved because `??` only falls through on null. The serializer
        // drops them (httpUrl), so nothing was ever rendered wrong, but this
        // sweep's `is null` test read them as "already has a repo" and skipped
        // every one: 87% of the corpus was silently excluded from repo search.
        sql`coalesce(${schema.subjects.repoUrl}, '') = ''`,
        // closed programs are the churn tail; their source was never public
        sql`${schema.subjects.facts}->>'closedAt' is null`,
        sql`${schema.subjects.facts}->>'repoLink' is null`,
        sql`(${schema.subjects.facts}->>'repoLinkCheckedAt' is null
             or (${schema.subjects.facts}->>'repoLinkCheckedAt')::timestamptz
                < now() - ${`${RECHECK_HOURS} hours`}::interval)`,
        sql`coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt})
            < now() - ${`${MIN_AGE_HOURS} hours`}::interval`,
        sql`coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt})
            > now() - ${`${LOOKBACK_DAYS} days`}::interval`,
      ),
    )
    // Crate-carrying programs first, then newest. Newest-first alone starves
    // them: mainnet deploys enough per hour that the top of the queue is always
    // fresh churn, and a program whose binary leaked `programs/<crate>/` is both
    // the likeliest to have a public repo and the only one the crate-path pass
    // can confirm. Everything still gets its turn — checked rows are stamped.
    .orderBy(
      sql`(${schema.subjects.crate} is null),
          coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt}) desc`,
    )
    .limit(SWEEP_MAX);

  if (!rows.length) return { checked: 0, linked: 0, skipped: "no-eligible-rows" };
  let linked = 0;

  for (const row of rows) {
    // subjects.crate is the workspace crate recovered from panic paths — the
    // same string the reverse lookup confirms against, so no bytecode refetch
    if (await linkOne(row.id, row.crate, network)) linked++;
  }

  logger.info({ network, checked: rows.length, linked }, "repo-link sweep");
  return { checked: rows.length, linked };
}
