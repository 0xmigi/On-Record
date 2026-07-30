// ---------------------------------------------------------------------------
// Source-tree recovery — the fork detector.
//
// TLSH answers "is this the same binary?". It cannot answer "is this the same
// source?", and that is the question that matters for forks. Measured on the
// live corpus: tail.trade is a build of Drift's crate — 88 shared source files
// — and its TLSH distance to Drift is 182 (similarity 0.39). No threshold
// rescues that, because the two binaries genuinely are not byte-similar. Same
// source, different build.
//
// What does survive every build is the panic path. Every `panic!`, `assert!`
// and `require!` embeds its own source location so the error can name itself,
// and those paths are relative to the workspace root. So a Solana program
// compiled from `programs/<crate>/src/…` carries its own crate name and file
// tree in the binary, and you cannot strip that without giving up panic
// messages entirely.
//
// Coverage on mainnet: 52% of programs leak a crate name (1,322 of 2,558).
// 82% of recovered names are unique to one program; the shared ones are real
// families the radar currently shows as unrelated — `oft` × 44 (LayerZero),
// `hyperlane-sealevel-fee` × 18, `smart_arb` × 24.
//
// Limits, stated plainly: renaming the crate defeats this completely, so it
// catches people who were not hiding. And shared source is evidence of shared
// code, not of affiliated teams — forking open source is normal.
//
// This logic mirrors apps/web/lib/composition.ts, which recovers the same tree
// client-side for the dossier's architecture panel. It lives here too so the
// pipeline can persist it and lineage can match on it.
// ---------------------------------------------------------------------------

/** Rust stdlib crate dirs — `<crate>/src/…` where crate is one of these is the
 *  standard library, not the program. */
const STDLIB_CRATES = new Set(["alloc", "core", "std", "proc_macro", "test"]);

/** Toolchain / registry fragments — a path containing these belongs to a
 *  dependency or the compiler, never to the program's own tree. */
const TOOLCHAIN_RE = /library\/|platform-tools|\.cargo|crates\.io|rustc|registry\/src/;

/** Crate names too generic to be identity on their own. A match on one of
 *  these is only meaningful with strong path overlap behind it. */
export const GENERIC_CRATES = new Set([
  "program",
  "programs",
  "src",
  "lib",
  "contract",
  "contracts",
  "solana",
  "anchor",
]);

export interface SourceTree {
  /** the workspace crate name, from `programs/<crate>/src/…` */
  crate: string | null;
  /** the program's own `.rs` paths, relative to its crate src/ */
  paths: string[];
}

/** Which workspace crate was this binary BUILT from, when its panic paths name
 *  several?
 *
 *  A program that CPIs into its siblings compiles their state and instruction
 *  modules in too, so `programs/<crate>/src/…` is not a single answer. Ripstr's
 *  pool binary is the case that exposed it: 33 `.rs` files under
 *  `programs/ripstr_pool/`, plus 5 each under `ripstr_amm` and `ripstr_rewards`
 *  — the CPI-side types it imports. Taking the first match meant taking
 *  whichever crate happened to appear in the longest extracted string, which
 *  named that binary `ripstr_amm`: one of its own dependencies, and the name of
 *  a DIFFERENT program the same team deployed 25 seconds later.
 *
 *  Weight decides instead. The crate that owns the binary is the one most of
 *  the recovered tree hangs off; an imported sibling contributes a handful of
 *  files. Ties keep first-seen order, so single-crate binaries — the common
 *  case, and every corpus row before this — resolve exactly as they did. */
export function dominantCrate(strings: string[]): string | null {
  return crateCandidates(strings)[0]?.crate ?? null;
}

/** Every workspace crate the binary's panic paths name, with how many distinct
 *  `.rs` files were recovered under each — heaviest first, so the head is the
 *  dominant crate. The tail is what the binary merely IMPORTED, which is how a
 *  name we already stored can be told apart from a name that is simply unknown
 *  to us: a stored name appearing here, but not at the head, is a
 *  misattribution this rule now corrects. */
export function crateCandidates(strings: string[]): { crate: string; files: number }[] {
  // crate → its distinct .rs files. Insertion-ordered, and Array.sort is stable,
  // which is what makes the tie-break "first seen" without tracking positions.
  const files = new Map<string, Set<string>>();

  for (const raw of strings) {
    // No toolchain guard here, unlike the generic `<dir>/src/<file>.rs` scan
    // below: `programs/<crate>/src/` is the workspace layout and can only be the
    // developer's own tree. Guarding it on a toolchain fragment appearing EARLIER
    // in the same string is wrong, because the extractor concatenates adjacent
    // literals — a lone `programs/donor_kebab/src/lib.rs` sharing a blob with a
    // `.cargo` path would be thrown away, and the crate lost entirely.
    //
    // The `.rs` tail is optional: a crate that leaks only `programs/<crate>/src/`
    // with no file after it is still a candidate, as it was before.
    // {0,40}: Cargo allows a one-character package name, and the tree scan this
    // replaced accepted them — don't narrow what we recognise on the way past
    for (const m of raw.matchAll(/programs\/([a-z0-9][a-z0-9_-]{0,40})\/src\/([a-z0-9_/-]+?\.rs)?/gi)) {
      const crate = m[1]!.toLowerCase();
      const seen = files.get(crate) ?? new Set<string>();
      if (m[2]) seen.add(m[2].toLowerCase());
      files.set(crate, seen);
    }
  }

  return [...files.entries()]
    .map(([crate, seen]) => ({ crate, files: seen.size }))
    .sort((a, b) => b.files - a.files);
}

/** Recover the program's own source tree from strings extracted out of its
 *  bytecode. Works per-string: the extractor concatenates adjacent literals
 *  with no separator, so joining and regexing globally bleeds paths together. */
export function recoverSourceTree(strings: string[]): SourceTree {
  const crate = dominantCrate(strings);
  const paths = new Set<string>();

  for (const raw of strings) {
    for (const m of raw.matchAll(/([a-z0-9_-]+)\/src\/([a-z0-9_/-]+?\.rs)/gi)) {
      if (STDLIB_CRATES.has((m[1] ?? "").toLowerCase())) continue;
      if (TOOLCHAIN_RE.test(raw.slice(0, m.index))) continue;
      if (m[2]) paths.add(m[2].toLowerCase());
    }
    for (const m of raw.matchAll(/(?:^|[^a-z0-9_/-])src\/([a-z0-9_/-]+?\.rs)/gi)) {
      if (TOOLCHAIN_RE.test(raw.slice(0, m.index))) continue;
      if (m[1]) paths.add(m[1].toLowerCase());
    }
  }
  return { crate, paths: [...paths].sort() };
}

/** Jaccard overlap of two recovered file-path sets, 0..1. This is the evidence
 *  that turns a crate-name coincidence into a lineage claim: two programs both
 *  called `amm` sharing only `lib.rs` is nothing; 88 shared paths is not. */
export function pathOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const p of a) if (setB.has(p)) shared++;
  const union = a.length + b.length - shared;
  return union === 0 ? 0 : shared / union;
}

/** How many paths two trees literally share — the number worth showing a human
 *  ("shares 88 source files with Drift"). */
export function sharedPathCount(a: string[], b: string[]): number {
  const setB = new Set(b);
  let n = 0;
  for (const p of a) if (setB.has(p)) n++;
  return n;
}

/** Is this pair strong enough to call lineage?
 *
 *  A shared crate name alone is NOT enough, and the corpus says so: Raydium
 *  and Meteora both compile a crate called `amm` and share exactly one file
 *  (overlap 0.02). They are unrelated. Trying to enumerate every generic name
 *  is a losing game — `amm`, `vault`, `router`, `staking` are all somebody's
 *  crate — so the name only ever nominates a candidate and the file tree
 *  decides.
 *
 *  Two ways to clear the bar, because programs leak wildly different numbers
 *  of paths: enough shared files in absolute terms, or a small tree that
 *  matches almost entirely. Known-generic names need substantially more. */
export function isSourceRelative(
  crate: string | null,
  otherCrate: string | null,
  shared: number,
  overlap: number,
): boolean {
  if (!crate || !otherCrate || crate !== otherCrate) return false;
  if (GENERIC_CRATES.has(crate)) return shared >= 8 && overlap >= 0.4;
  return shared >= 3 || overlap >= 0.5;
}
