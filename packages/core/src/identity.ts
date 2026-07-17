import { extractStrings } from "./fingerprint.js";
import type { BytecodeIdentity } from "./types.js";

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

/** Recover project identity from the SBF bytecode. */
export function deriveBytecodeIdentity(bytecode: Uint8Array): BytecodeIdentity {
  const strings = extractStrings(bytecode, 8, 500);
  const sec = parseSecurityTxt(bytecode);
  const firstMatch = (re: RegExp): string | null =>
    strings.map((s) => s.match(re)?.[0]).find(Boolean) ?? null;

  // project/crate name from leaked Rust panic paths: programs/<name>/src/...
  let nameFromPath: string | null = null;
  for (const s of strings) {
    const m = s.match(/programs\/([a-z0-9][a-z0-9_-]{1,40})\/src\//i);
    if (m) {
      nameFromPath = m[1]!;
      break;
    }
  }

  // repo: the project's declared source (security.txt) wins; else a github URL
  // from the strings that isn't a known dependency org.
  const projectGithub = strings
    .map((s) => s.match(/https?:\/\/github\.com\/[^\s"']+/i)?.[0])
    .find((u) => u && !DEP_REPO_ORGS.test(u));
  const repoUrl = sec?.source_code ?? projectGithub ?? null;
  const social =
    sec?.contacts?.match(/https?:\/\/(?:x|twitter)\.com\/[^\s,"']+/i)?.[0] ??
    firstMatch(/https?:\/\/(?:x|twitter)\.com\/[^\s"']+/i) ??
    null;
  const website =
    sec?.project_url ??
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
  };
}
