import { logger } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Verified-builds check via the OtterSec API (spec §4.2). "Verified" means the
// on-chain bytecode was reproduced from a public repo at a known commit —
// which is what lets a story say "the code is public and matches".
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
