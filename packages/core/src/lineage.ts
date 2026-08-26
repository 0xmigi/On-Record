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

// ---------------------------------------------------------------------------
// When the nearest match must not be PRESENTED as a specific relative.
//
// The window above is for the scan — it is deliberately permissive, because a
// fork can be many times its origin and we would rather compare too much than
// miss the relationship. What it is not is a licence to put a name on the
// result. Two failure modes were live on the radar:
//
//  1. A crowd. Thirty-six programs within five similarity points of each other
//     means the "nearest" is one arbitrary member of a lookalike pack — the
//     score is measuring "is a Pinocchio program", not kinship.
//
//  2. A size chasm. TLSH encodes body length in one byte and penalises the
//     difference, but past roughly 3x the penalty saturates and what is left is
//     byte-distribution shape. Measured on 3,458 mainnet pairs, every one of
//     the 13 false "fork of X" chips on the radar sat between 4.3x and 5.0x —
//     Marinade Liquid Staking labelled a fork of Tensor (1,224 KB vs 258 KB),
//     Token-2022 a fork of NOTCH Classic, raydium-clmm a fork of stork. None
//     share a line of code.
//
//  3. Two different crates. The size test only catches the far pairs; it says
//     nothing about two unrelated programs that happen to be the same size, and
//     at these sizes Anchor boilerplate dominates the hash. Virtuals' Agentic
//     Commerce (518 KB) was chipped "fork of Zenex Revshare Pools" (520 KB) at
//     distance 12 — different team, different site, different everything. The
//     crate name is the developer's own Cargo package, recovered from panic
//     paths, and it is the same evidence resolveSourceKin() already trusts over
//     the fuzzy hash. Two programs that name different crates are not one
//     forking the other.
//
// So the thresholds below are calibrated on this corpus, not derived. 3x sits
// under the observed size-failure band with margin. The crate test was run over
// all 478 live fork chips: 372 have both crates known, 96 keep the chip
// (oft→oft, dvn→dvn, whirlpool→Orca Whirlpool — all genuine), and 276 lose it.
// Of those 276, 273 name wholly unrelated crates; the only 3 where one crate
// contains the other are example-native-token-transfers→native-token-transfers
// and two hanging off crates as generic as `staking` and `vault`. Rescuing one
// true relative was not worth the carve-out, and the match is still shown.
//
// A weak match is still shown — it is a real measurement and the row keeps it —
// but it stops being the headline and stops being called a fork.
// ---------------------------------------------------------------------------

/** Distinct programs within 5 similarity points before "nearest" means nothing. */
export const NEAREST_CROWD_PEERS = 6;
/** How far apart in size two binaries may be and still be called relatives. */
export const NEAREST_MAX_SIZE_RATIO = 3;

export type NearestWeakness = "crowd" | "size" | "crate";

/** Why this match can't carry a name, or null if it can. */
export function nearestWeakness(
  peersWithin5: number | null | undefined,
  sizeBytes: number | null | undefined,
  neighborSizeBytes: number | null | undefined,
  crate?: string | null,
  neighborCrate?: string | null,
): NearestWeakness | null {
  if ((peersWithin5 ?? 0) >= NEAREST_CROWD_PEERS) return "crowd";
  if (sizeBytes && neighborSizeBytes) {
    const ratio = Math.max(sizeBytes / neighborSizeBytes, neighborSizeBytes / sizeBytes);
    if (ratio >= NEAREST_MAX_SIZE_RATIO) return "size";
  }
  // Only when BOTH are known: the crate comes out of panic paths and is absent
  // on roughly 15% of programs, and an unknown crate is not evidence of
  // anything. Those matches keep whatever the two tests above decided.
  if (crate && neighborCrate && crate !== neighborCrate) return "crate";
  return null;
}
