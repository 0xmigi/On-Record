import type { Problem, Report } from "./doctor.js";

// ---------------------------------------------------------------------------
// Per-version verification labels for The Record.
//
// Verification belongs to a version: an upgrade replaces the bytes, and a
// verification describes bytes. So each row of the record is labelled by its
// hash. The pipeline hashes every version exactly as solana-verify does (the
// ELF after the 45-byte ProgramData header, trailing zero padding stripped),
// so a build hash from OtterSec lines up with a row with no translation.
//
// Only the current version gets "not verified" and a reason: it is the one
// anyone can still act on. An older version is either known to have been
// reproduced from source, or carries no label at all. "No verified build on
// record" is not evidence that one never existed: OtterSec keeps only its
// latest build per uploader, so older evidence disappears as teams re-verify.
// The API persists each match it sees; this function only reads what it's
// given.
// ---------------------------------------------------------------------------

export interface VersionLabel {
  state: "verified" | "not-verified" | "pending";
  /** Short reason, current version only. */
  reason?: string;
  repoUrl?: string;
  commit?: string;
  verifiedAt?: string | null;
}

/** Hash → label. Hashes with nothing to say are absent. */
export type VersionLabels = Record<string, VersionLabel>;

/** A fresh upgrade that nobody has re-verified yet is the normal state of
 *  affairs for a team that does verify: verification always comes after the
 *  deploy it describes. Within this window it reads "not verified yet". */
export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

const REASONS: Record<Problem | "never-submitted", string> = {
  stale: "the recipe is for an older version",
  "never-built": "recipe uploaded, never built",
  "source-missing": "the source repo is gone",
  "commit-missing": "the commit is missing from the repo",
  "hash-differs": "the rebuild doesn't match",
  "not-marked": "build matches, not marked verified",
  signer: "not signed by the upgrade authority",
  "never-submitted": "never submitted",
};

export function versionLabels(report: Report, now = Date.now()): VersionLabels {
  const labels: VersionLabels = {};

  // Older versions: any per-uploader build OtterSec marked verified whose
  // output equals the bytes that were on chain when it ran.
  for (const rec of report.records ?? []) {
    if (!rec.is_verified || !rec.executable_hash || rec.executable_hash !== rec.on_chain_hash) continue;
    labels[rec.executable_hash] = {
      state: "verified",
      repoUrl: rec.repo_url,
      commit: rec.commit,
      verifiedAt: rec.last_verified_at,
    };
  }

  // The current version is decided by the report, not the records: a record
  // can match while the status explorers read says not verified (seen when
  // the uploader isn't the current authority).
  const p = report.program;
  if (!p || report.cluster !== "mainnet") return labels;
  if (report.status === "verified" && report.osec) {
    labels[p.hash] = {
      state: "verified",
      repoUrl: report.osec.repo_url,
      commit: report.osec.commit,
      verifiedAt: report.osec.last_verified_at,
    };
    return labels;
  }

  const primary = report.primary !== null ? report.uploads[report.primary] : undefined;
  const problem = report.uploads.length ? primary?.problem ?? null : "never-submitted";
  const fresh = p.deployedAt !== null && now - Date.parse(p.deployedAt) < PENDING_WINDOW_MS;
  // pending only for a team that has verified before: an upload exists
  const pending = fresh && report.uploads.length > 0 && (problem === "stale" || problem === "never-built");
  labels[p.hash] = pending
    ? { state: "pending", reason: "upgraded in the last day, not re-verified yet" }
    : { state: "not-verified", reason: problem ? REASONS[problem] : undefined };
  return labels;
}
