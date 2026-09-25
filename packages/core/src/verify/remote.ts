// ---------------------------------------------------------------------------
// The two off-chain facts the doctor needs: what OtterSec's builder did with
// each upload, and whether the source a recipe points at still exists.
//
// OtterSec's /status is what explorers show. /status-all keeps one record per
// uploader with the hash its build produced, and that record is what separates
// "never built" from "built, but the bytes differ". A record can outlive its
// upload (the upload was closed) or describe an older recipe from the same
// uploader, so records are matched on signer AND commit.
// ---------------------------------------------------------------------------

const OSEC = "https://verify.osec.io";

export interface OsecRecord {
  signer?: string;
  is_verified: boolean;
  on_chain_hash: string;
  /** "" when no build has run for this record. */
  executable_hash: string;
  repo_url: string;
  commit: string;
  last_verified_at: string | null;
  is_frozen?: boolean;
  is_closed?: boolean;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** null = the API could not be reached, which is not the same as "no record". */
export async function osecStatus(programId: string): Promise<OsecRecord | null> {
  return getJson<OsecRecord>(`${OSEC}/status/${programId}`);
}

export async function osecStatusAll(programId: string): Promise<OsecRecord[] | null> {
  const records = await getJson<OsecRecord[]>(`${OSEC}/status-all/${programId}`);
  return Array.isArray(records) ? records : null;
}

export type Presence = "ok" | "missing" | "unknown";

export interface SourceCheck {
  host: "github" | "other" | "none";
  repo: Presence;
  commit: Presence;
  /** Why a check came back unknown (rate limit, network). */
  note?: string;
  web?: string;
}

/** Owner/repo out of any GitHub URL shape the recipes use: plain, .git,
 *  /tree/<commit>, ssh. */
export function parseGithub(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/i, "") };
}

export async function checkSource(gitUrl: string, commit: string, token?: string): Promise<SourceCheck> {
  if (!gitUrl) return { host: "none", repo: "missing", commit: "unknown" };
  const gh = parseGithub(gitUrl);
  if (!gh) return { host: "other", repo: "unknown", commit: "unknown", note: "not a GitHub URL, so not checked" };

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "onrecord",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const probe = async (path: string): Promise<{ state: Presence; note?: string }> => {
    try {
      const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}${path}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { state: "ok" };
      // unauthenticated calls get 60/hour; a limit is "don't know", never "missing"
      if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        return { state: "unknown", note: "GitHub rate limit reached (set GITHUB_TOKEN to raise it)" };
      }
      if (res.status === 404 || res.status === 422) return { state: "missing" };
      return { state: "unknown", note: `GitHub answered HTTP ${res.status}` };
    } catch (err) {
      return { state: "unknown", note: `GitHub unreachable: ${String(err)}` };
    }
  };

  const web = `https://github.com/${gh.owner}/${gh.repo}`;
  const repo = await probe("");
  if (repo.state !== "ok") return { host: "github", repo: repo.state, commit: "unknown", note: repo.note, web };
  if (!commit) return { host: "github", repo: "ok", commit: "unknown", note: "no commit pinned", web };
  const c = await probe(`/commits/${commit}`);
  return { host: "github", repo: "ok", commit: c.state, note: c.note, web };
}
