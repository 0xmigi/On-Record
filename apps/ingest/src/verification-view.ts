import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db,
  schema,
  env,
  logger,
  rpcUrl,
  diagnoseVerification,
  versionLabels,
  type VerificationFix,
  type VerificationReport,
  type VersionLabel,
  type VersionLabels,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Verification per version, for The Record.
//
// Runs the verify doctor (packages/core/src/verify) against mainnet and
// labels each version by hash. What it learns is kept: OtterSec
// holds only its latest build per uploader, so the evidence that an older
// version was verified disappears from their API as soon as the team verifies
// the next one. Every match seen here is stamped onto the events carrying that
// hash (enrichment.verification) and merged back in on every read, so the
// record keeps a version's label after OtterSec has moved on.
//
// Mainnet only: OtterSec's remote verifier doesn't serve devnet.
// ---------------------------------------------------------------------------

export interface VerificationView {
  checkedAt: string;
  /** The live version's diagnosis; null when the program isn't live on mainnet. */
  current: {
    hash: string;
    status: VerificationReport["status"];
    diagnosis: string;
    fixes: VerificationFix[];
    notes: string[];
  } | null;
  versions: VersionLabels;
}

interface Stamp {
  verified: true;
  repoUrl?: string;
  commit?: string;
  verifiedAt?: string | null;
  seenAt: string;
}

/** OtterSec, GitHub and the chain all move slowly next to a page view. */
const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { view: VerificationView; at: number }>();
const inFlight = new Map<string, Promise<VerificationView | null>>();

export function getVerificationView(programId: string): Promise<VerificationView | null> {
  const hit = cache.get(programId);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.view);
  let run = inFlight.get(programId);
  if (!run) {
    run = build(programId)
      .then((view) => {
        if (view) cache.set(programId, { view, at: Date.now() });
        return view;
      })
      .catch((err: unknown) => {
        logger.warn({ programId, err: String(err) }, "verification view failed");
        return null;
      })
      .finally(() => inFlight.delete(programId));
    inFlight.set(programId, run);
  }
  return run;
}

async function build(programId: string): Promise<VerificationView> {
  const report = await diagnoseVerification(programId, {
    rpcUrl: rpcUrl("mainnet"),
    githubToken: env.GITHUB_TOKEN || undefined,
  });
  const live = versionLabels(report);

  const rows = await db
    .select({ hash: schema.events.sha256After, stamp: sql<Stamp | null>`${schema.events.enrichment}->'verification'` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.programId, programId),
        eq(schema.events.network, "mainnet"),
        isNotNull(schema.events.sha256After),
      ),
    );

  // stamps fill in what OtterSec no longer holds; the live answer wins where
  // there is one, so the current version always reflects today
  const versions: VersionLabels = { ...live };
  const stamped = new Set<string>();
  for (const r of rows) {
    if (!r.hash || !r.stamp?.verified) continue;
    stamped.add(r.hash);
    versions[r.hash] ??= fromStamp(r.stamp);
  }

  // keep every new match, on every event that carries those bytes
  const onRecord = new Set(rows.map((r) => r.hash));
  for (const [hash, label] of Object.entries(live)) {
    if (label.state !== "verified" || stamped.has(hash) || !onRecord.has(hash)) continue;
    const stamp: Stamp = {
      verified: true,
      repoUrl: label.repoUrl,
      commit: label.commit,
      verifiedAt: label.verifiedAt ?? null,
      seenAt: new Date().toISOString(),
    };
    await db
      .update(schema.events)
      .set({
        enrichment: sql`jsonb_set(coalesce(${schema.events.enrichment}, '{}'::jsonb), '{verification}', ${JSON.stringify(stamp)}::jsonb, true)`,
      })
      .where(
        and(
          eq(schema.events.programId, programId),
          eq(schema.events.network, "mainnet"),
          eq(schema.events.sha256After, hash),
          isNull(sql`${schema.events.enrichment}->'verification'`),
        ),
      );
  }

  const p = report.program;
  return {
    checkedAt: new Date().toISOString(),
    current: p
      ? { hash: p.hash, status: report.status, diagnosis: report.diagnosis, fixes: report.fixes, notes: report.notes }
      : null,
    versions,
  };
}

function fromStamp(s: Stamp): VersionLabel {
  return { state: "verified", repoUrl: s.repoUrl, commit: s.commit, verifiedAt: s.verifiedAt ?? null };
}
