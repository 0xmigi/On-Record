// ---------------------------------------------------------------------------
// Primitive rarity — the scoring half.
//
// A program's syscall imports are the operations it reaches out to the runtime
// for. How rare those are is a real signal: almost every program calls memcpy
// and logs, so seeing those narrows nothing down, while a handful call pairing
// crypto or ask whether the cluster restarted. Those are programs whose author
// was solving a problem nobody else has.
//
// This lives in core because `interest.ts` scores against it. The web app has
// its own copy of the same table for the labels and explanations it renders —
// that copy is presentation, THIS one decides ranking. Keep the tiers in step
// until the API serves them and the web copy can be deleted.
//
// Shares are measured over 3,254 mainnet programs with a recovered syscall
// vector (2026-08-03), excluding the 872 that import only `sol_invoke_signed_c`
// (one template mass-deployed, a fifth of the raw corpus).
//
// Rules are matched FIRST-WIN, ordered rarest-first, so a specific rule must
// precede any generic rule that would also match it.
// ---------------------------------------------------------------------------

export type PrimitiveTier =
  | "mythical"
  | "legendary"
  | "epic"
  | "rare"
  | "uncommon"
  | "common";

/** How much a program reaching this tier is worth. Normalised by MAX_TIER_WEIGHT. */
export const PRIMITIVE_TIER_WEIGHT: Record<PrimitiveTier, number> = {
  mythical: 10,
  legendary: 6,
  epic: 4,
  rare: 2,
  uncommon: 1,
  common: 0,
};

const MAX_TIER_WEIGHT = 10;

interface Rule {
  tier: PrimitiveTier;
  match: RegExp;
}

const RULES: Rule[] = [
  // mythical — not activated on mainnet, or activated and never once imported
  { tier: "mythical", match: /bls12_381/ },
  { tier: "mythical", match: /curve_pairing_map|curve_decompress/ },
  { tier: "mythical", match: /big_mod_exp/ },
  { tier: "mythical", match: /blake3/ },
  { tier: "mythical", match: /remaining_compute_units/ },

  // legendary — under 1% of programs
  { tier: "legendary", match: /create_account_with_seed/ },
  { tier: "legendary", match: /epoch_rewards/ },
  { tier: "legendary", match: /epoch_stake/ },
  { tier: "legendary", match: /curve_multiscalar_mul/ },
  { tier: "legendary", match: /last_restart/ },
  { tier: "legendary", match: /sibling/ },
  { tier: "legendary", match: /epoch_schedule/ },
  { tier: "legendary", match: /curve_group_op/ },
  { tier: "legendary", match: /poseidon/ },
  { tier: "legendary", match: /alt_bn128/ },

  // epic — 1-3%
  { tier: "epic", match: /log_compute_units/ },
  { tier: "epic", match: /stack_height/ },
  { tier: "epic", match: /curve_validate_point/ },
  { tier: "epic", match: /curve_/ },
  { tier: "epic", match: /log_64_/ },
  { tier: "epic", match: /secp256k1/ },

  // rare — 3-15%
  { tier: "rare", match: /get_sysvar/ },
  { tier: "rare", match: /keccak/ },
  { tier: "rare", match: /return_data/ },

  // uncommon — 15-60%
  { tier: "uncommon", match: /invoke_signed_c/ },
  { tier: "uncommon", match: /panic/ },
  { tier: "uncommon", match: /log_data/ },
  { tier: "uncommon", match: /create_program_address/ },
  { tier: "uncommon", match: /get_clock_sysvar/ },
  { tier: "uncommon", match: /sha256/ },

  // common — over 60%, plus two deliberate floors:
  //   fossils   `alloc_free_` and `get_fees_sysvar` are as rare as anything
  //             legendary and worth nothing — rare because deprecated, not
  //             because hard. They must not pay novelty weight.
  //   no signal memory ops and basic logging are in almost everything and
  //             never distinguish a program, whatever their exact share.
  { tier: "common", match: /alloc_free/ },
  { tier: "common", match: /get_fees_sysvar/ },
  { tier: "common", match: /mem(cpy|move|set|cmp)/ },
  { tier: "common", match: /abort/ },
  { tier: "common", match: /sysvar|get_epoch/ },
  { tier: "common", match: /invoke/ },
  { tier: "common", match: /program_address/ },
  { tier: "common", match: /log/ },
];

/** The tier a single syscall falls in. Unknown names score as common. */
export function primitiveTier(syscall: string): PrimitiveTier {
  return RULES.find((r) => r.match.test(syscall))?.tier ?? "common";
}

export interface PrimitiveRarity {
  /** the rarest tier the program reaches — its headline */
  peak: PrimitiveTier | null;
  /** how many distinct tiers at `rare` or above it reaches */
  rareCount: number;
  /** 0..1, the peak tier normalised. What the interest score consumes. */
  score: number;
}

/**
 * Rarity of a program's syscall set, scored on its PEAK tier: the single
 * rarest thing it calls. Deliberately not a sum — a program importing twelve
 * common syscalls is not more interesting than one importing five, and summing
 * would rank bloat above signal.
 */
export function primitiveRarity(syscalls: string[] | null | undefined): PrimitiveRarity {
  if (!syscalls?.length) return { peak: null, rareCount: 0, score: 0 };

  const tiers = new Set<PrimitiveTier>();
  for (const s of syscalls) tiers.add(primitiveTier(s));

  let peak: PrimitiveTier | null = null;
  for (const t of tiers) {
    if (peak === null || PRIMITIVE_TIER_WEIGHT[t] > PRIMITIVE_TIER_WEIGHT[peak]) peak = t;
  }

  const rareCount = [...tiers].filter(
    (t) => PRIMITIVE_TIER_WEIGHT[t] >= PRIMITIVE_TIER_WEIGHT.rare,
  ).length;

  return {
    peak,
    rareCount,
    score: peak ? PRIMITIVE_TIER_WEIGHT[peak] / MAX_TIER_WEIGHT : 0,
  };
}
