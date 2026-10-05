import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  searchProgramIdInRepo,
  env,
  type SourceFrameworkFact as CoreSourceFrameworkFact,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Framework from SOURCE, for the frameworks the binary cannot name.
//
// Quasar (blueshift-gg/quasar) compiles to bytes the profiler reads as
// Pinocchio, and nothing in them says otherwise. Checked 2026-10-05 against its
// own examples plus every deployed program declared in a public repo that
// depends on quasar-lang (14 real deploys): no panic paths survive, the ELF
// is stock `cargo build-sbf`, and its one habit — hashing PDAs itself
// (sol_sha256 + sol_curve_validate_point, no PDA syscall) — is shared by 177
// programs on record, including ones that name themselves Pinocchio, because
// solana-address ships the same routine.
//
// The source can say it. A program's repo — declared, or found by searching
// for its address — holds a crate that declares this program id; that crate's
// Cargo.toml names its framework. Only that crate counts: example repos keep
// Anchor, native and Quasar versions side by side, sometimes under ONE id
// (QuickNode's do), so "the repo uses quasar-lang" proves nothing.
//
// Verdict rules:
//   quasar  every framework crate that mentions the id depends on quasar-lang
//   mixed   quasar-lang and another framework both declare it — not labelled
//   none    the declaring crates use something else
//   no-hits nothing in the repo mentions the id (index lag, private, renamed)
// And never over the bytes: an Anchor binary is Anchor whatever a repo says.
// ---------------------------------------------------------------------------

export type SourceFrameworkFact = CoreSourceFrameworkFact;
type SourceVerdict = SourceFrameworkFact["verdict"];

const RAW = "https://raw.githubusercontent.com";
const FETCH_TIMEOUT_MS = 8000;
const MAX_FILES = 12;

function githubRepo(url: string | null | undefined): string | null {
  const m = url?.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function raw(repo: string, path: string): Promise<string | null> {
  const url = `${RAW}/${repo}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "on-record (+https://on-record.azuolas.xyz)" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 200_000 ? null : text;
  } catch {
    return null;
  }
}

/** The framework a crate builds with, from its runtime dependencies only —
 *  a dev-dependency (test harness, client) says nothing about the program. */
export function crateFramework(manifest: string): string {
  const deps = new Set<string>();
  let section = "";
  for (const line of manifest.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1]!.trim();
      // [dependencies.quasar-lang] form
      const dotted = section.match(/^(?:target\.[^.]+(?:\.[^.]+)*\.)?dependencies\.(.+)$/);
      if (dotted) deps.add(dotted[1]!.replace(/"/g, ""));
      continue;
    }
    const runtime = /^(?:target\..+\.)?dependencies$/.test(section);
    const dep = runtime && line.match(/^\s*"?([A-Za-z0-9_-]+)"?\s*=/);
    if (dep) deps.add(dep[1]!);
  }
  const has = (n: string) => deps.has(n) || deps.has(n.replace(/-/g, "_"));
  if (has("quasar-lang")) return "quasar";
  if (has("anchor-lang") || has("anchor-lang-v2")) return "anchor";
  if (has("pinocchio")) return "pinocchio";
  if (has("solana-program")) return "native";
  return "other";
}

/** Nearest Cargo.toml with a [package] above a file, walking toward the root. */
async function owningManifest(
  repo: string,
  file: string,
  cache: Map<string, string | null>,
): Promise<{ path: string; text: string } | null> {
  const parts = file.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const path = [...parts.slice(0, i), "Cargo.toml"].join("/");
    if (!cache.has(path)) cache.set(path, await raw(repo, path));
    const text = cache.get(path);
    if (text && /^\s*\[package\]/m.test(text)) return { path, text };
  }
  return null;
}

/** Read one repo for which crate declares `programId` and what it builds with.
 *  `paths` are files already known to mention the id (a repo link's
 *  matchedPaths); without them one repo-scoped code search is spent.
 *  null = could not ask (no token, throttled) — not a verdict. */
export async function readSourceFramework(
  programId: string,
  repo: string,
  repoFrom: SourceFrameworkFact["repoFrom"],
  paths?: string[] | null,
): Promise<SourceFrameworkFact | null> {
  let files = paths?.length ? paths : await searchProgramIdInRepo(programId, repo);
  if (files === null) return null;
  files = files.filter((p) => p.endsWith(".rs")).slice(0, MAX_FILES);

  const cache = new Map<string, string | null>();
  const crates = new Map<string, string>();
  for (const f of files) {
    // the id must really be in the file — matchedPaths can be stale
    const body = await raw(repo, f);
    if (!body?.includes(programId)) continue;
    const m = await owningManifest(repo, f, cache);
    if (m) crates.set(m.path, crateFramework(m.text));
  }
  const kinds = new Set([...crates.values()].filter((k) => k !== "other"));
  const verdict: SourceVerdict = !crates.size
    ? "no-hits"
    : kinds.has("quasar")
      ? kinds.size === 1
        ? "quasar"
        : "mixed"
      : "none";
  return {
    framework: verdict === "quasar" ? "quasar" : null,
    verdict,
    repo,
    repoFrom,
    crates: [...crates].map(([manifest, framework]) => ({ manifest, framework })),
    checkedAt: new Date().toISOString(),
  };
}

// --- the sweep ---------------------------------------------------------------

const SWEEP_MAX = Number(process.env.SOURCE_FRAMEWORK_SWEEP_MAX ?? 25);
const RECHECK_DAYS = Number(process.env.SOURCE_FRAMEWORK_RECHECK_DAYS ?? 30);

interface Candidate {
  id: string;
  repo: string;
  repoFrom: SourceFrameworkFact["repoFrom"];
  paths: string[] | null;
}

/** Which repo to read for a program, most authoritative first. */
function pickRepo(row: {
  repoUrl: string | null;
  facts: unknown;
}): Omit<Candidate, "id"> | null {
  const f = (row.facts ?? {}) as {
    repoUrlDead?: boolean;
    repoLink?: { repoUrl?: string; matchedPaths?: string[] };
    pmpSecurity?: { source_code?: unknown };
  };
  const declared = f.repoUrlDead ? null : githubRepo(row.repoUrl);
  if (declared) {
    // a link to the same repo already knows which files hold the id
    const sameAsLink = githubRepo(f.repoLink?.repoUrl)?.toLowerCase() === declared.toLowerCase();
    return { repo: declared, repoFrom: "declared", paths: sameAsLink ? (f.repoLink?.matchedPaths ?? null) : null };
  }
  const pmp = typeof f.pmpSecurity?.source_code === "string" ? githubRepo(f.pmpSecurity.source_code) : null;
  if (pmp) return { repo: pmp, repoFrom: "pmp-security", paths: null };
  const linked = githubRepo(f.repoLink?.repoUrl);
  if (linked) return { repo: linked, repoFrom: "linked", paths: f.repoLink?.matchedPaths ?? null };
  return null;
}

export async function sweepSourceFramework(
  opts: { dry?: boolean; max?: number; verbose?: boolean; ids?: string[] } = {},
): Promise<{ checked: number; quasar: number; skipped?: "no-token" }> {
  if (!env.GITHUB_TOKEN) return { checked: 0, quasar: 0, skipped: "no-token" };
  const staleBefore = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString();
  const rows = await db
    .select({ id: schema.subjects.id, repoUrl: schema.subjects.repoUrl, facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        opts.ids?.length ? inArray(schema.subjects.id, opts.ids) : undefined,
        // the bytes come first: Quasar's output reads as Pinocchio (or native
        // when it is tiny) — an Anchor binary is never relabelled from source
        sql`coalesce(${schema.subjects.profile}->>'framework', 'unknown') <> 'anchor'`,
        sql`not (${schema.subjects.facts} ? 'closedAt')`,
        sql`((${schema.subjects.repoUrl} ilike '%github.com/%' and not coalesce((${schema.subjects.facts}->>'repoUrlDead')::boolean, false))
          or ${schema.subjects.facts}->'repoLink'->>'repoUrl' ilike '%github.com/%'
          or ${schema.subjects.facts}->'pmpSecurity'->>'source_code' ilike '%github.com/%')`,
        opts.ids?.length
          ? undefined
          : sql`coalesce(${schema.subjects.facts}->'sourceFramework'->>'checkedAt', '') < ${staleBefore}`,
      ),
    )
    .orderBy(sql`${schema.subjects.facts}->'sourceFramework'->>'checkedAt' nulls first`)
    .limit(opts.max ?? SWEEP_MAX);

  let checked = 0;
  let quasar = 0;
  for (const row of rows) {
    const pick = pickRepo(row);
    if (!pick) continue;
    const fact = await readSourceFramework(row.id, pick.repo, pick.repoFrom, pick.paths);
    if (!fact) break; // out of search budget — the next run picks up here
    checked++;
    if (fact.framework === "quasar") quasar++;
    if (opts.verbose || fact.verdict === "quasar" || fact.verdict === "mixed")
      logger.info({ id: row.id, ...fact, dry: Boolean(opts.dry) }, "source framework");
    if (opts.dry) continue;
    await db
      .update(schema.subjects)
      .set({
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ sourceFramework: fact })}::jsonb`,
      })
      .where(eq(schema.subjects.id, row.id));
  }
  return { checked, quasar };
}
