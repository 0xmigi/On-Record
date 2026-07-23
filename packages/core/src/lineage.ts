// ---------------------------------------------------------------------------
// The size window used to prefilter lineage candidates.
//
// This existed as a hardcoded ±20% in three places and it was the reason the
// radar told us tail.trade was "novel code". tail.trade is a build of Drift's
// crate — 88 source files, all of them `programs/drift/src/` — but at 4.35 MB
// against Drift's 193 KB row it is 22x larger, so the two were never compared.
//
// ±20% is a *clone* window. It assumes a fork is roughly the size of what it
// forked. Real forks are not: they add markets, instructions, an IDL, new
// state. Growth is the normal case, and the old window made exactly the
// interesting relationships invisible while happily matching byte-identical
// copy-paste.
//
// So the window is asymmetric: a candidate may be much smaller than the
// program we're classifying (it could be the leaner original), but only
// modestly larger (a program 10x bigger than this one is not its ancestor).
// TLSH does the real work; this only bounds the scan.
// ---------------------------------------------------------------------------

/** How much smaller a relative may be — a fork can be many times its origin. */
export const LINEAGE_SIZE_FLOOR = 0.1;
/** How much larger a relative may be — kept tight; scanning up is expensive
 *  and a far larger program is rarely the thing this one derives from. */
export const LINEAGE_SIZE_CEIL = 2.0;

/** Inclusive [lo, hi] byte bounds for lineage candidates of a program. */
export function lineageSizeWindow(sizeBytes: number): [number, number] {
  return [
    Math.floor(sizeBytes * LINEAGE_SIZE_FLOOR),
    Math.ceil(sizeBytes * LINEAGE_SIZE_CEIL),
  ];
}
