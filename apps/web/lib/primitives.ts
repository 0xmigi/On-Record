// ---------------------------------------------------------------------------
// Primitives — the operations a program reaches OUT to the Solana runtime for
// (its syscall imports: the doors out of the sandbox). Distinct from Recovered
// Architecture, which is what the developer built INTO the program. This is the
// external-asks half.
//
// Each primitive carries a rarity tier — like a game item. The tier answers one
// question: how much does seeing this tell you about the program? Common ones
// (memory, logging) are in everything and narrow nothing down; legendary ones
// (pairing crypto, restart detection) are in a handful of programs and mean the
// author was solving a problem almost nobody else has.
//
// CALIBRATION. Tiers were a hand-assigned balance sheet. They are now measured:
// MEASURED holds the share of mainnet programs carrying each syscall, over
// 3,497 programs with a recovered syscall vector (2026-08-05). Programs
// importing only `sol_invoke_signed_c` and nothing else are excluded from the
// denominator — 873 of them are one template mass-deployed, and leaving them in
// deflated every percentage by a fifth. MEASURED is the ONLY place a percentage
// is written down; the dossier and /methodology both derive from it.
//
// Two deliberate departures from raw frequency:
//   1. NO-SIGNAL FLOOR. Memory ops and basic logging sit at `common` whatever
//      their individual frequency, because they never distinguish a program.
//      `sol_memcmp_` is in 58% of programs and tells you nothing.
//   2. FOSSILS. `alloc_free_` (0.09%) and `get_fees_sysvar` (0.03%) are as rare
//      as anything in the legendary tier, and worthless as signal — they are
//      rare because they are deprecated and those programs were never rewritten.
//      Floored at `common` so they pay no novelty weight.
//
// Rules are matched FIRST-WIN and the table is ordered rarest-first, so any
// specific rule must precede the generic rule that would also match it —
// `get_sysvar` before `sysvar`, `create_program_address` before
// `program_address`, `log_data`/`log_64_` before `log`. Re-check that ordering
// whenever a rule is added, and re-measure MEASURED as the corpus grows: these
// figures drift, and a stale table quietly stops discriminating.
//
// The generic `curve_` fallback is intentionally unreachable today and exists
// to catch the future.
//
// BLS12-381 has NO syscall of its own — checked against the Agave registry,
// which has no `sol_bls12_381_*` name. It rides the existing `sol_curve_group_op`
// (legendary) and `sol_curve_pairing_map` (mythical) behind the
// `enable_bls12_381_syscall` gate, activated on mainnet at slot 425,952,004
// (~June 2026). A rule matching /bls12_381/ therefore matched nothing and could
// never fire, so it was removed rather than left rendering a phantom row.
// ---------------------------------------------------------------------------

export type Tier = "mythical" | "legendary" | "epic" | "rare" | "uncommon" | "common";

export const TIER_ORDER: Tier[] = ["mythical", "legendary", "epic", "rare", "uncommon", "common"];
export const TIER_WEIGHT: Record<Tier, number> = {
  mythical: 10, // wide gap — a frontier import should dominate the score
  legendary: 6,
  epic: 4,
  rare: 2,
  uncommon: 1,
  common: 0,
};

/** Corpus MEASURED was taken over. Surfaced on the methodology page. */
export const CALIBRATION = {
  network: "mainnet",
  programs: 3497,
  measuredAt: "2026-08-05",
  note: "Programs whose only syscall is sol_invoke_signed_c are excluded from the denominator.",
} as const;

// Canonical source of the syscall list: the validator's own registry.
export const SYSCALL_SOURCE_URL = "https://github.com/anza-xyz/agave/blob/master/syscalls/src/lib.rs";

export interface SyscallRule {
  tier: Tier;
  label: string;
  explain: string;
  match: RegExp;
  /** tier is held below its measured rarity on purpose — see header */
  floored?: "no-signal" | "fossil";
  /** internal catch-all for syscalls no specific rule claims; not a primitive
   *  worth showing on its own, so /methodology hides it */
  fallback?: true;
}

/**
 * Share of mainnet programs importing each syscall. THE single source of truth
 * for every percentage rendered anywhere — the dossier and the methodology page
 * both derive from this, so they cannot disagree. `null` = the syscall exists in
 * the registry but is not activated on mainnet, so no program can import it.
 *
 * Re-measure as the corpus grows; see CALIBRATION for what it was measured over.
 */
export const MEASURED: Record<string, number | null> = {
  sol_memcpy_: 96.4,
  sol_log_: 91.54,
  sol_memset_: 85.16,
  sol_try_find_program_address: 80.73,
  sol_invoke_signed_rust: 76.92,
  sol_get_rent_sysvar: 73.01,
  abort: 71.83,
  sol_log_pubkey: 61.02,
  sol_memcmp_: 58.56,
  sol_get_clock_sysvar: 55.16,
  sol_sha256: 53.96,
  sol_create_program_address: 45.95,
  sol_log_data: 35.77,
  sol_memmove_: 29.0,
  sol_panic_: 20.07,
  sol_invoke_signed_c: 20.02,
  sol_set_return_data: 12.67,
  sol_keccak256: 9.15,
  sol_get_sysvar: 7.26,
  sol_get_return_data: 6.75,
  sol_secp256k1_recover: 2.6,
  sol_log_64_: 2.0,
  sol_curve_validate_point: 1.66,
  sol_get_stack_height: 1.57,
  sol_log_compute_units_: 1.37,
  sol_alt_bn128_group_op: 0.89,
  sol_poseidon: 0.54,
  sol_curve_group_op: 0.31,
  sol_alt_bn128_compression: 0.29,
  sol_get_epoch_schedule_sysvar: 0.23,
  sol_get_processed_sibling_instruction: 0.2,
  sol_get_last_restart_slot: 0.17,
  sol_alloc_free_: 0.09,
  sol_curve_multiscalar_mul: 0.06,
  sol_get_epoch_stake: 0.06,
  sol_get_epoch_rewards_sysvar: 0.06,
  sol_create_account_with_seed_instruction: 0.03,
  sol_get_fees_sysvar: 0.03,

  // Activated on mainnet (June 2026, with the BLS12-381 gate) and imported by
  // nothing on record — a real zero, not an absence of opportunity.
  sol_curve_pairing_map: 0,

  // `null` = registered in the validator but the feature gate has never been
  // activated on mainnet, so no program *can* import it. Verified against the
  // feature accounts on chain: none of these four has one. Distinct from the 0
  // above, and /methodology renders them as "—" rather than "0".
  sol_blake3: null,
  sol_big_mod_exp: null,
  sol_remaining_compute_units: null,
  sol_sha512: null,
};

export const SYSCALL_TIERS: SyscallRule[] = [
  // --- mythical: not activated, or activated and never once imported ---------
  { tier: "mythical", label: "Pairing map", explain: "The BLS12-381 pairing operation (SIMD-0388), live on mainnet since June 2026 — one signature proving a whole group signed. Callable today; nothing on record imports it.", match: /curve_pairing_map|curve_decompress/ },
  { tier: "mythical", label: "Big modular exponentiation", explain: "RSA-style signature and VDF verification. Registered in the validator, but the feature gate has never been activated on mainnet.", match: /big_mod_exp/ },
  { tier: "mythical", label: "BLAKE3 hashing", explain: "Fast content hashing. Registered in the validator, but the feature gate has never been activated on mainnet.", match: /blake3/ },
  { tier: "mythical", label: "Compute budget introspection", explain: "Would let a program read its own remaining compute and do less work instead of failing. Registered in the validator, but the feature gate has never been activated on mainnet.", match: /remaining_compute_units/ },
  { tier: "mythical", label: "SHA-512", explain: "Same slice-based interface as the other hash syscalls, 64-byte output. Proposed as SIMD-0512 and activated on no cluster at all — not mainnet, not testnet, not devnet.", match: /sha512/ },

  // --- legendary: under 1% of programs ---------------------------------------
  { tier: "legendary", label: "Seeded account creation", explain: "Likely used here to build a create-account-with-seed instruction.", match: /create_account_with_seed/ },
  { tier: "legendary", label: "Epoch rewards state", explain: "Likely used here to act on reward distribution — stake-pool internals.", match: /epoch_rewards/ },
  { tier: "legendary", label: "Validator stake read", explain: "Likely used here to weight logic by a validator's active stake.", match: /epoch_stake/ },
  { tier: "legendary", label: "Batch curve multiplication", explain: "Likely used here to verify many proofs at once.", match: /curve_multiscalar_mul/ },
  { tier: "legendary", label: "Cluster restart detection", explain: "Likely used here to refuse to act on prices posted before a cluster restart — operational paranoia, mostly market makers.", match: /last_restart/ },
  { tier: "legendary", label: "Sibling instruction inspection", explain: "Likely used here to read the other instructions in the same transaction — sandwich and MEV defence.", match: /sibling/ },
  { tier: "legendary", label: "Epoch schedule read", explain: "Likely used here for logic that depends on where the epoch boundary falls.", match: /epoch_schedule/ },
  { tier: "legendary", label: "Curve group arithmetic", explain: "Likely used here to add encrypted values without decrypting them — confidential balances.", match: /curve_group_op/ },
  { tier: "legendary", label: "ZK hashing (Poseidon)", explain: "A hash designed to be cheap inside a zero-knowledge circuit — a strong tell the program does real ZK.", match: /poseidon/ },
  { tier: "legendary", label: "Pairing crypto (alt_bn128)", explain: "Likely used here to verify a zero-knowledge proof on-chain (BN254 pairing math).", match: /alt_bn128/ },

  // --- epic: 1–3% ------------------------------------------------------------
  { tier: "epic", label: "Compute-unit logging", explain: "Prints remaining compute. Usually a profiling call someone left in the shipped build.", match: /log_compute_units/ },
  { tier: "epic", label: "CPI depth check", explain: "Likely used here to tell whether it was called directly or wrapped by another program — the cheapest MEV defence available.", match: /stack_height/ },
  { tier: "epic", label: "Curve point validation", explain: "Likely used here to check a point is on the curve — confidential transfer territory.", match: /curve_validate_point/ },
  { tier: "epic", label: "Curve operations", explain: "Likely used here for ed25519 or ristretto arithmetic.", match: /curve_/, fallback: true },
  { tier: "epic", label: "Legacy logging", explain: "The pre-2021 logging call. Signals an old codebase.", match: /log_64_/ },
  { tier: "epic", label: "secp256k1 recovery", explain: "Likely used here to verify Ethereum-style signatures — often a bridge, or an EVM wallet authorising something.", match: /secp256k1/ },

  // --- rare: 3–15% -----------------------------------------------------------
  { tier: "rare", label: "Generic sysvar read", explain: "Reads a byte range from a sysvar without loading the account — the modern, compute-cheap way.", match: /get_sysvar/ },
  { tier: "rare", label: "Keccak-256", explain: "Likely used here for EVM-compatible hashing or address derivation.", match: /keccak/ },
  { tier: "rare", label: "Return data", explain: "Likely used here to return a value from a cross-program call instead of writing it to an account.", match: /return_data/ },

  // --- uncommon: 15–60% ------------------------------------------------------
  { tier: "uncommon", label: "Cross-program calls (C ABI)", explain: "Calls other programs via the C ABI — Pinocchio or hand-rolled rather than Anchor.", match: /invoke_signed_c/ },
  { tier: "uncommon", label: "Panic", explain: "Used here to abort with file and line information.", match: /panic/ },
  { tier: "uncommon", label: "Event data logging", explain: "Emits raw bytes to the transaction log — structured events, meant to be indexed.", match: /log_data/ },
  { tier: "uncommon", label: "PDA derivation (known bump)", explain: "Derives a program-owned address from a bump it already stored — the cheap path.", match: /create_program_address/ },
  { tier: "uncommon", label: "Clock reads", explain: "Likely used here for time-gated logic.", match: /get_clock_sysvar/ },
  { tier: "uncommon", label: "SHA-256", explain: "Used here to commit state or build Merkle proofs. Also every Anchor discriminator.", match: /sha256/ },

  // --- common: >60%, plus the deliberate floors ------------------------------
  { tier: "common", label: "Allocator", explain: "Heap allocation via a syscall deprecated years ago. Only pre-2022 programs still carry it.", match: /alloc_free/, floored: "fossil" },
  { tier: "common", label: "Fee calculator", explain: "A deprecated sysvar. One program on mainnet still reads it.", match: /get_fees_sysvar/, floored: "fossil" },
  { tier: "common", label: "Memory ops", explain: "Used here for low-level data handling.", match: /mem(cpy|move|set|cmp)/, floored: "no-signal" },
  { tier: "common", label: "Abort", explain: "Used here to halt on unrecoverable errors.", match: /abort/ },
  { tier: "common", label: "Sysvar reads", explain: "Likely used here for rent- or epoch-aware logic.", match: /sysvar|get_epoch/ },
  { tier: "common", label: "Cross-program calls", explain: "Used here to compose with other on-chain programs.", match: /invoke/ },
  { tier: "common", label: "PDA derivation", explain: "Used here to control its own program-owned accounts.", match: /program_address/ },
  { tier: "common", label: "Logging", explain: "Used here to emit transaction logs.", match: /log/, floored: "no-signal" },
];

/** The rule a syscall name falls under — first-win, so table order matters. */
export function ruleFor(syscall: string): SyscallRule | undefined {
  return SYSCALL_TIERS.find((r) => r.match.test(syscall));
}

export interface RuleGroup {
  rule: SyscallRule;
  /** every known syscall this rule claims, commonest first */
  syscalls: { name: string; pct: number | null }[];
  /** the rule's headline share — the commonest syscall under it */
  pct: number | null;
}

/**
 * Every rule paired with the known syscalls it actually claims, derived by
 * running MEASURED through the same first-win matcher the dossier uses. The
 * methodology page renders this, so what it shows is what programs are scored
 * against — a rule that stops matching anything shows up as empty rather than
 * silently lying.
 */
export function measuredByRule(): RuleGroup[] {
  const groups = new Map<SyscallRule, { name: string; pct: number | null }[]>();
  for (const rule of SYSCALL_TIERS) groups.set(rule, []);
  for (const [name, pct] of Object.entries(MEASURED)) {
    const rule = ruleFor(name);
    if (rule) groups.get(rule)?.push({ name, pct });
  }
  return SYSCALL_TIERS.map((rule) => {
    const syscalls = (groups.get(rule) ?? []).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    const known = syscalls.map((s) => s.pct).filter((p): p is number => p != null);
    return { rule, syscalls, pct: known.length ? Math.max(...known) : null };
  });
}

// Capability-level fallback for programs whose API response has no raw syscall
// vector yet (only the coarse capability set). Deliberately conservative: the
// coarse set can't distinguish a 0.06% syscall from a 73% one, so nothing here
// is allowed above `epic`.
const CAP_TIERS: Record<string, { tier: Tier; label: string; explain: string }> = {
  "advanced-crypto": { tier: "epic", label: "Advanced cryptography", explain: "Likely used here for zero-knowledge proofs or signature aggregation." },
  hashing: { tier: "uncommon", label: "Hashing", explain: "Likely used here to commit state or build Merkle proofs." },
  "return-data": { tier: "rare", label: "Return data", explain: "Likely used here to return values from a cross-program call." },
  sysvars: { tier: "common", label: "Sysvar reads", explain: "Likely used here for time- or epoch-aware logic." },
  cpi: { tier: "common", label: "Cross-program calls", explain: "Likely used here to compose with other on-chain programs." },
  pda: { tier: "common", label: "PDA derivation", explain: "Likely used here to control its own program-owned accounts." },
  tokens: { tier: "common", label: "Token handling", explain: "Likely used here to move SPL tokens." },
};

export interface Primitive {
  label: string;
  tier: Tier;
  explain: string; // one-line plain-English description
  syscalls: string[]; // the raw sol_* names behind it (empty on the capability fallback)
  pct: number | null; // share of mainnet programs carrying it
}

export interface Primitives {
  items: Primitive[]; // rarest first
  peak: Tier | null; // the rarest tier reached — the program's headline rarity
  rareCount: number; // how many primitives are rare or above
  score: number; // summed tier weight — the raw novelty contribution
  precise: boolean; // true = per-syscall; false = coarse capability fallback
}

export function derivePrimitives(syscalls: string[], capabilities: string[]): Primitives {
  const precise = syscalls.length > 0;
  let items: Primitive[];

  if (precise) {
    // group syscalls under their matched rarity label (dedupes log_/log_64_ etc.)
    const byLabel = new Map<string, { tier: Tier; explain: string; syscalls: string[] }>();
    for (const s of syscalls) {
      const rule = ruleFor(s);
      const label = rule?.label ?? "Other";
      const tier: Tier = rule?.tier ?? "common";
      const explain = rule?.explain ?? "An imported syscall.";
      const cur = byLabel.get(label) ?? { tier, explain, syscalls: [] };
      cur.syscalls.push(s);
      byLabel.set(label, cur);
    }
    items = [...byLabel.entries()].map(([label, v]) => {
      // headline share = the commonest syscall this program actually imports
      // under that label, read straight from MEASURED so it can never disagree
      // with the methodology page.
      const known = v.syscalls.map((s) => MEASURED[s]).filter((p): p is number => p != null);
      return {
        label,
        tier: v.tier,
        explain: v.explain,
        pct: known.length ? Math.max(...known) : null,
        syscalls: v.syscalls,
      };
    });
  } else {
    items = capabilities
      .map((c): Primitive | null => {
        const t = CAP_TIERS[c];
        // no raw syscall vector, so no honest percentage to report
        return t ? { label: t.label, tier: t.tier, explain: t.explain, pct: null, syscalls: [] } : null;
      })
      .filter((x): x is Primitive => x != null);
  }

  items.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  const peak = items.reduce<Tier | null>(
    (p, i) => (p == null || TIER_WEIGHT[i.tier] > TIER_WEIGHT[p] ? i.tier : p),
    null,
  );
  const rareCount = items.filter((i) => TIER_WEIGHT[i.tier] >= TIER_WEIGHT.rare).length;
  const score = items.reduce((s, i) => s + TIER_WEIGHT[i.tier], 0);

  return { items, peak, rareCount, score, precise };
}
