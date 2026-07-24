import { env } from "./config.js";
import { extractStrings } from "./fingerprint.js";
import { logger } from "./logger.js";
import type { BytecodeIdentity, RepoLink } from "./types.js";

// ---------------------------------------------------------------------------
// De-opaquing (real-data findings): parsing the program binary recovers project
// identity that every explorer misses. ~52% of otherwise-anonymous programs get
// a name from Rust panic paths (`programs/<name>/src/lib.rs`) or an embedded
// Neodyme security.txt; many also leak a repo, socials, or a website.
// ---------------------------------------------------------------------------

// the full Neodyme solana-security-txt field set (required + optional)
const SEC_KEYS = [
  "name",
  "project_url",
  "contacts",
  "policy",
  "preferred_languages",
  "source_code",
  "source_revision",
  "source_release",
  "encryption",
  "auditors",
  "acknowledgements",
  "expiry",
];
const SEC_BEGIN = "=======BEGIN SECURITY.TXT V1=======";
const SEC_END = "=======END SECURITY.TXT V1=======";

/** Neodyme security.txt: a delimited, null-separated key/value block embedded in
 *  the binary. The richest free identity signal we get. */
export function parseSecurityTxt(bytecode: Uint8Array): Record<string, string> | null {
  const latin = Buffer.from(bytecode).toString("latin1");
  const begin = latin.indexOf(SEC_BEGIN);
  if (begin < 0) return null;
  const end = latin.indexOf(SEC_END, begin);
  if (end < 0) return null;
  // The block is a strict key\0value\0… stream, wrapped in a boundary \0 right
  // after BEGIN and right before END. Strip only those boundary NULs — NOT
  // interior empties. A field the developer left blank (e.g. an unset
  // `contacts`) still occupies its slot as an empty value; dropping it would
  // shift every following key/value pair by one, binding each label to the
  // next field's value (e.g. `contacts: policy`).
  const parts = latin
    .slice(begin + SEC_BEGIN.length, end)
    .replace(/^\0+/, "")
    .replace(/\0+$/, "")
    .split("\0");
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i]!;
    // values were sliced out of a latin1 view of the binary — re-decode as
    // UTF-8 so names like "Firstance — pump.fun Vault" don't mojibake ("â€”")
    if (SEC_KEYS.includes(key)) out[key] = Buffer.from(parts[i + 1]!, "latin1").toString("utf8");
  }
  return Object.keys(out).length ? out : null;
}

// GitHub orgs that show up in almost every Rust/Solana binary's panic strings —
// these are DEPENDENCIES, not the program's own repo. Matching them would flag
// every program as having a repo, so they're excluded from the string-scrape.
const DEP_REPO_ORGS =
  /github\.com\/(?:solana-labs|solana-program|anza-xyz|coral-xyz|project-serum|metaplex-foundation|rust-lang|rustsec|dtolnay|serde-rs|tokio-rs|bytecodealliance|paritytech|rust-num|pyth-network|switchboard-xyz)\b/i;

/** Accept a URL only if it's plain http(s). Security.txt fields are attacker-
 *  controlled bytes inside the deployed binary and end up in anchor hrefs —
 *  a `javascript:` scheme here is script execution in the app's origin. */
export function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : null;
}

/** Recover project identity from the SBF bytecode. */
export function deriveBytecodeIdentity(bytecode: Uint8Array): BytecodeIdentity {
  const strings = extractStrings(bytecode, 8, 500);
  const sec = parseSecurityTxt(bytecode);
  const firstMatch = (re: RegExp): string | null =>
    strings.map((s) => s.match(re)?.[0]).find(Boolean) ?? null;

  // project/crate name from leaked Rust panic paths: programs/<name>/src/...
  const nameFromPath = crateFromStrings(strings);

  // repo: the project's declared source (security.txt) wins; else a github URL
  // from the strings that isn't a known dependency org.
  const projectGithub = strings
    .map((s) => s.match(/https?:\/\/github\.com\/[^\s"']+/i)?.[0])
    .find((u) => u && !DEP_REPO_ORGS.test(u));
  const repoUrl = httpUrl(sec?.source_code) ?? projectGithub ?? null;
  const social =
    sec?.contacts?.match(/https?:\/\/(?:x|twitter)\.com\/[^\s,"']+/i)?.[0] ??
    firstMatch(/https?:\/\/(?:x|twitter)\.com\/[^\s"']+/i) ??
    null;
  const website =
    httpUrl(sec?.project_url) ??
    firstMatch(/https?:\/\/[a-z0-9.-]+\.(?:io|xyz|app|fi|so|finance|money|network)\b[^\s"']*/i) ??
    null;
  const anchor = strings.some((s) =>
    /anchor:idl|IdlCreateAccount|Constraint(?:HasOne|Signer|Seeds)/.test(s),
  );

  return {
    name: sec?.name ?? nameFromPath ?? null,
    repoUrl,
    social,
    website,
    hasSecurityTxt: Boolean(sec),
    securityTxt: sec,
    anchor,
    crate: nameFromPath,
  };
}

/** The crate the binary leaks through Rust panic paths. `name` may come from
 *  security.txt instead, so the crate is kept separately: it is not a label but
 *  a real directory (`programs/<crate>/`) that must also exist in the source
 *  repo — the hinge the reverse lookup below turns on. */
function crateFromStrings(strings: string[]): string | null {
  for (const s of strings) {
    const m = s.match(/programs\/([a-z0-9][a-z0-9_-]{1,40})\/src\//i);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Program id → source repo (GitHub code search).
//
// security.txt is the declared path to a repo, and only a minority of deploys
// take it. The undeclared path is the program id itself: 32 bytes of entropy
// that a developer who publishes their source commits verbatim — declare_id!,
// Anchor.toml, the generated IDL, a frontend constant. Searching public code
// for the address finds the repo the binary never names.
//
// This is an inference, so it only counts when the link closes in BOTH
// directions: the binary leaks `programs/<crate>/src/…`, and the candidate repo
// contains that same crate path — or the repo declares this exact address as
// its own program. One direction alone is a claim anyone can plant: a README
// quoting someone else's program id, an address-list repo scraping mainnet.
// Forks are dropped; they inherit their parent's declare_id! and would
// otherwise attribute every deploy to whoever forked the framework.
//
// Code search needs a token and is capped at ~10 requests/minute — far below
// deploy volume — so calls are spaced, cached, and SKIPPED rather than queued
// when the budget is gone. A missed link is recovered on the program's next
// upgrade or by a backfill; a pipeline stalled behind a rate limiter is not.
// ---------------------------------------------------------------------------

const GH_SEARCH_URL = "https://api.github.com/search/code";
const GH_TIMEOUT_MS = 10_000;
/** 10 req/min is the documented code-search ceiling; 6.5s spacing leaves slack. */
const GH_SPACING_MS = 6_500;
/** How long a caller will wait for a slot before giving up on this program. */
const GH_MAX_WAIT_MS = 8_000;
const GH_CACHE_HIT_MS = 24 * 60 * 60 * 1000;
/** Misses expire sooner: a repo published tomorrow should still be found. */
const GH_CACHE_MISS_MS = 6 * 60 * 60 * 1000;
const GH_MAX_PATHS = 8;
const GH_MAX_ITEMS = 30;
/** Repos to fetch stars for when candidates tie — a bounded tiebreak. */
const GH_MAX_TIEBREAK = 5;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Cargo's own naming rules. The crate comes out of attacker-controlled
 *  bytecode and goes into a search query, so it is validated, not trusted. */
const CRATE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/;

interface GhSearchItem {
  path?: string;
  repository?: { full_name?: string; html_url?: string; fork?: boolean };
  text_matches?: { fragment?: string }[];
}

const cache = new Map<string, { value: RepoLink | null; at: number }>();
/** Next moment a request may be sent; claimed synchronously so concurrent
 *  pipeline workers queue behind each other instead of all firing at once. */
let nextSlotAt = 0;
/** Set when GitHub says we're over budget — every caller short-circuits until
 *  the reset it named, rather than burning retries into a closed window. */
let cooldownUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Claim a request slot, waiting at most `maxWaitMs`. False = skip this program. */
async function takeSlot(maxWaitMs: number): Promise<boolean> {
  const now = Date.now();
  if (now < cooldownUntil) return false;
  const slot = Math.max(now, nextSlotAt);
  if (slot - now > maxWaitMs) return false;
  nextSlotAt = slot + GH_SPACING_MS; // claim before awaiting — single-threaded, so atomic
  if (slot > now) await sleep(slot - now);
  return true;
}

/** What GitHub last said, so a silent null can be explained from outside the
 *  process. A 403 on every call (a token the search endpoint won't accept)
 *  and "this program genuinely has no public repo" are indistinguishable
 *  otherwise — both just return null. */
let lastSearch: { at: string; status: number | null; note: string } | null = null;

export function repoSearchStatus(): {
  tokenPresent: boolean;
  cooldownUntil: string | null;
  last: { at: string; status: number | null; note: string } | null;
} {
  return {
    tokenPresent: Boolean(env.GITHUB_TOKEN), // presence only, never the value
    cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
    last: lastSearch,
  };
}

/** Park all callers until the window GitHub named (or a minute, if it named none). */
function enterCooldown(res: Response): void {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const until = Number.isFinite(retryAfter)
    ? Date.now() + retryAfter * 1000
    : Number.isFinite(reset) && reset > 0
      ? reset * 1000
      : Date.now() + 60_000;
  cooldownUntil = Math.max(cooldownUntil, until);
}

/** Does this hit show the repo claiming the address as ITS OWN program?
 *  `declare_id!("<id>")` at a crate root, or the id bound to a program in
 *  Anchor.toml. The crate-root restriction is what separates a self-declaration
 *  from a registry of other people's ids — Drift's `programs/drift/src/ids.rs`
 *  declares Jupiter's address in a `mod jupiter_mainnet_6` block, and Anchor CPI
 *  stub crates declare whatever program they wrap. Fragments are compared
 *  case-sensitively: code search folds case, base58 does not, and a case-folded
 *  hit is a different address. */
function isDeclaration(item: GhSearchItem, programId: string): boolean {
  const path = item.path ?? "";
  const fragments = (item.text_matches ?? []).map((m) => m.fragment ?? "");
  const exact = fragments.filter((f) => f.includes(programId));
  if (!exact.length) return false;
  if (/(?:^|\/)Anchor\.toml$/.test(path)) return true;
  if (!/(?:^|\/)lib\.rs$/.test(path)) return false;
  return exact.some((f) => new RegExp(`declare_id!\\s*\\(\\s*"${programId}"`).test(f));
}

interface Candidate {
  repo: string;
  url: string;
  paths: string[];
  count: number;
  declared: boolean;
  crate: boolean;
}

/** Fold the flat hit list into one candidate per repo, best first. */
function rankCandidates(
  items: GhSearchItem[],
  programId: string,
  crateName: string | null,
): Candidate[] {
  const byRepo = new Map<
    string,
    { url: string; paths: string[]; count: number; declared: boolean; crate: boolean }
  >();

  for (const item of items) {
    const repo = item.repository?.full_name;
    const path = item.path;
    if (!repo || !path || item.repository?.fork) continue;
    const entry = byRepo.get(repo) ?? {
      url: item.repository?.html_url ?? `https://github.com/${repo}`,
      paths: [],
      count: 0,
      declared: false,
      crate: false,
    };
    entry.count += 1;
    if (entry.paths.length < GH_MAX_PATHS) entry.paths.push(path);
    if (isDeclaration(item, programId)) entry.declared = true;
    if (crateName && path.startsWith(`programs/${crateName}/`)) entry.crate = true;
    byRepo.set(repo, entry);
  }

  return (
    [...byRepo.entries()]
      .map(([repo, e]) => ({ repo, ...e }))
      // An address can appear in any repo; only the binary's own crate path, or
      // a self-declaration, makes it THIS program's source. A declaration with
      // no crate to confirm it needs corroboration — a project references its
      // own id in more than one file (Anchor.toml, the client, the IDL), a
      // vendored id usually sits alone.
      .filter((c) => c.crate || (c.declared && c.count > 1))
      .sort(
        (a, b) =>
          Number(b.crate) - Number(a.crate) ||
          Number(b.declared) - Number(a.declared) ||
          b.count - a.count,
      )
  );
}

/** Stars for a candidate repo, or null if the call fails. Repo reads are on the
 *  core REST budget (5,000/hr), not the 10/min search budget — cheap enough to
 *  spend only when candidates tie, never on the happy path. */
async function repoStars(repo: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "on-record",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { stargazers_count?: number }).stargazers_count ?? null;
  } catch {
    return null;
  }
}

/** Same crate, several repos — copies, renames, and hard forks that GitHub does
 *  not mark as forks (a fork flag only covers forks made through GitHub). The
 *  original is the one the ecosystem actually watches, so break the tie on
 *  stars; ordering by match count would hand it to whoever vendored the most
 *  files. */
async function pickCanonical(candidates: Candidate[]): Promise<Candidate> {
  const contenders = candidates.slice(0, GH_MAX_TIEBREAK);
  const starred = await Promise.all(
    contenders.map(async (c) => ({ c, stars: (await repoStars(c.repo)) ?? -1 })),
  );
  starred.sort((a, b) => b.stars - a.stars);
  return starred[0]!.c;
}

/** Find the public repo behind a program id. Returns null when the token is
 *  unset, the rate-limit budget is spent, or nothing links back convincingly —
 *  the program just keeps whatever identity the binary already gave it. */
export async function searchRepoByProgramId(
  programId: string,
  opts: { crateName?: string | null; maxWaitMs?: number; bustCache?: boolean } = {},
): Promise<RepoLink | null> {
  if (!env.GITHUB_TOKEN) return null;
  // the id is interpolated into a query string and a RegExp below — anything
  // that isn't a plain base58 address has no business in either
  if (!BASE58_ADDRESS.test(programId)) return null;

  const hit = cache.get(programId);
  if (hit && !opts.bustCache) {
    const ttl = hit.value ? GH_CACHE_HIT_MS : GH_CACHE_MISS_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  const crate = CRATE_NAME.test(opts.crateName ?? "") ? opts.crateName! : null;
  const maxWait = opts.maxWaitMs ?? GH_MAX_WAIT_MS;

  // Pass 1: the bare address. Finds the repo directly for anything that isn't
  // widely integrated, and catches frontends and IDLs the crate filter misses.
  const broad = await runSearch(programId, programId, maxWait);
  if (!broad) return null; // never actually asked — don't cache a non-answer
  let candidates = rankCandidates(broad, programId, crate);

  // Pass 2: a widely-integrated program's own repo drowns in the hundreds of
  // third parties that hardcode its address — the source itself never reaches
  // the first page. Scoping to the crate path the binary leaked cuts straight
  // to repos that could have built it. Only spent when pass 1 came back empty.
  if (!candidates.length && crate) {
    const scoped = await runSearch(programId, `${programId} path:programs/${crate}`, maxWait);
    if (scoped) candidates = rankCandidates(scoped, programId, crate);
  }

  let value: RepoLink | null = null;
  if (candidates.length) {
    const best = candidates.length > 1 ? await pickCanonical(candidates) : candidates[0]!;
    value = {
      repo: best.repo,
      repoUrl: best.url,
      method: best.declared ? "declared" : "crate-path",
      crateConfirmed: best.crate,
      matchedPaths: best.paths,
      matchCount: best.count,
      otherCandidates: candidates.length - 1,
      queriedAt: new Date().toISOString(),
    };
  }

  if (cache.size > 5_000) cache.clear();
  cache.set(programId, { value, at: Date.now() });
  if (value) {
    logger.info(
      { programId, repo: value.repo, method: value.method, others: value.otherCandidates },
      "repo linked",
    );
  }
  return value;
}

/** One code-search request against the rate-limit budget. Never throws: a
 *  missing repo link must not fail an event. `[]` means GitHub answered and had
 *  nothing; `null` means we never got to ask (no slot, throttled, transient
 *  error) — the caller must not cache that as "this program has no repo". */
async function runSearch(
  programId: string,
  query: string,
  maxWaitMs: number,
): Promise<GhSearchItem[] | null> {
  if (!(await takeSlot(maxWaitMs))) {
    lastSearch = { at: new Date().toISOString(), status: null, note: "skipped — no slot within the wait budget" };
    logger.debug({ programId }, "github code search skipped — rate-limit budget spent");
    return null;
  }
  try {
    const url = `${GH_SEARCH_URL}?q=${encodeURIComponent(query)}&per_page=${GH_MAX_ITEMS}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      headers: {
        // text-match gives us the surrounding source line, which is how a
        // declare_id! is told apart from an address sitting in a list
        accept: "application/vnd.github.text-match+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "on-record",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 403 || res.status === 429) {
      enterCooldown(res);
      // 403 is not always throttling — a token the search endpoint rejects
      // looks identical from here, so keep GitHub's own words
      const body = (await res.text()).slice(0, 200);
      lastSearch = { at: new Date().toISOString(), status: res.status, note: body };
      logger.warn({ programId, status: res.status, body }, "github code search refused");
      return null;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      lastSearch = { at: new Date().toISOString(), status: res.status, note: body };
      logger.warn({ programId, status: res.status, body }, "github code search failed");
      return null;
    }
    const items = ((await res.json()) as { items?: GhSearchItem[] }).items ?? [];
    lastSearch = { at: new Date().toISOString(), status: 200, note: `${items.length} hits` };
    return items;
  } catch (err) {
    lastSearch = { at: new Date().toISOString(), status: null, note: String(err) };
    logger.warn({ programId, err: String(err) }, "github code search failed");
    return null;
  }
}
