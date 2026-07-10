import { logger } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Verified-builds check via the OtterSec API (SPEC §2). "Verified" means the
// on-chain bytecode was reproduced from a public repo at a known commit — an
// open-source boost to the novelty score and a "verified" badge on the radar.
// 24h in-process cache; identify always busts it on a fresh upgrade.
// ---------------------------------------------------------------------------

export interface Verification {
  verified: boolean;
  repoUrl: string | null;
  commit: string | null;
}

const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { value: Verification; at: number }>();

interface OtterSecResponse {
  is_verified?: boolean;
  repo_url?: string;
  commit?: string;
  message?: string;
}

export async function checkVerification(
  programId: string,
  opts: { bustCache?: boolean } = {},
): Promise<Verification> {
  const hit = cache.get(programId);
  if (hit && !opts.bustCache && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value: Verification = { verified: false, repoUrl: null, commit: null };
  try {
    const res = await fetch(
      `https://verify.osec.io/status/${encodeURIComponent(programId)}`,
      { headers: { accept: "application/json" } },
    );
    if (res.ok) {
      const json = (await res.json()) as OtterSecResponse;
      value = {
        verified: json.is_verified === true,
        repoUrl: json.repo_url ?? null,
        commit: json.commit ?? null,
      };
    }
  } catch (err) {
    logger.warn({ programId, err: String(err) }, "verification check failed");
  }
  cache.set(programId, { value, at: Date.now() });
  return value;
}

// ---------------------------------------------------------------------------
// Reverse hash lookup: which verified repos produce this exact bytecode?
// Our fingerprint sha256 (header-stripped, zero-trimmed) matches OtterSec's
// on_chain_hash format byte-for-byte (verified against Squads v4 + Drift,
// 2026-07-09), so the radar's own hashes query this directly. A hit on an
// otherwise-anonymous deploy means "byte-identical to <repo>" — the strongest
// lineage fact we can state, and it's a lookup, not an inference.
// ---------------------------------------------------------------------------

export interface CodeMatch {
  /** program id the verified build belongs to (the "original") */
  programId: string;
  repository: string;
  commit: string | null;
  /** OtterSec marks builds it trusts (their own re-verification) */
  trusted: boolean;
}

interface ResolveHashResponse {
  builds?: {
    program_id?: string;
    repository?: string;
    commit?: string;
    matches_deployed?: boolean;
    trusted?: boolean;
  }[];
}

const hashCache = new Map<string, { value: CodeMatch | null; at: number }>();

/** Look up verified builds whose output hash equals `sha256`. Returns the
 *  best match (trusted first), or null. Cached 24h per hash. */
export async function resolveCodeMatch(sha256: string): Promise<CodeMatch | null> {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) return null;
  const hit = hashCache.get(sha256);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value: CodeMatch | null = null;
  try {
    const res = await fetch(`https://verify.osec.io/resolve-hash/${sha256}`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const json = (await res.json()) as ResolveHashResponse;
      const builds = (json.builds ?? []).filter((b) => b.program_id && b.repository);
      builds.sort((a, b) => Number(b.trusted ?? false) - Number(a.trusted ?? false));
      const best = builds[0];
      if (best) {
        value = {
          programId: best.program_id!,
          repository: best.repository!,
          commit: best.commit ?? null,
          trusted: best.trusted === true,
        };
      }
    }
  } catch (err) {
    logger.warn({ sha256, err: String(err) }, "resolve-hash lookup failed");
  }
  hashCache.set(sha256, { value, at: Date.now() });
  return value;
}
