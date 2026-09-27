import { and, eq, isNotNull, sql } from "drizzle-orm";
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
import { openBreak, stampVerified, type Stamp } from "./verification-stamps.js";

// ---------------------------------------------------------------------------
// Verification per version, for The Record.
//
// Runs the verify doctor (packages/core/src/verify) against mainnet and
// labels each version by hash. Every match seen here is kept on the record
// (verification-stamps.ts) and merged back in on every read, so a version
// keeps its label after OtterSec has moved on.
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
  /** The upgrade that broke a verification, while the live version is still
   *  unverified. null when nothing broke, or it has been re-verified since. */
  broke: {
    slot: number;
    signature: string;
    blockTime: string | null;
    previousHash: string;
    repoUrl: string | null;
    commit: string | null;
    /** what the "before" claim rests on; the page words it accordingly */
    evidence: "verified" | "reproduced";
  } | null;
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
    await stampVerified(programId, "mainnet", hash, label, "page");
  }

  const p = report.program;
  const brk = p && versions[p.hash]?.state !== "verified" ? await openBreak(programId, "mainnet") : null;
  return {
    checkedAt: new Date().toISOString(),
    current: p
      ? { hash: p.hash, status: report.status, diagnosis: report.diagnosis, fixes: report.fixes, notes: report.notes }
      : null,
    versions,
    broke: brk
      ? {
          slot: brk.slot,
          signature: brk.signature,
          blockTime: brk.blockTime,
          previousHash: brk.previousHash,
          repoUrl: brk.repoUrl,
          commit: brk.commit,
          evidence: brk.evidence,
        }
      : null,
  };
}

function fromStamp(s: Stamp): VersionLabel {
  return { state: "verified", repoUrl: s.repoUrl, commit: s.commit, verifiedAt: s.verifiedAt ?? null };
}
