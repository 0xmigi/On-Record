// ---------------------------------------------------------------------------
// Primitives — the operations a program reaches OUT to the Solana runtime for
// (its syscall imports: the doors out of the sandbox). Distinct from Recovered
// Architecture, which is what the developer built INTO the program. This is the
// external-asks half.
//
// Each primitive carries a rarity tier — like a game item. Common ones (logging,
// memory) every program has; legendary ones (pairing crypto, ZK hashing) almost
// none do. A program stacked with rare primitives is doing something unusual —
// that's the novelty signal, made legible. Tiers here are a fixed table (a
// balance sheet we can tune); corpus-measured frequency can calibrate it later.
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

// Per-syscall rarity — matched first-win, rarest first, so the frontier/BLS
// rules must precede the generic curve_ rule. Synced to the Agave registry
// (syscalls/src/lib.rs), 2026-07-17. Labels are names, not sentences.
//
// Mythical = feature-gated frontier: BLS12-381 (SIMD-0388) — pairing crypto
// where the signer group can change. The rarest thing a program can import,
// and a live frontier as new SIMDs activate.
// Canonical source of the syscall list: the validator's own registry.
export const SYSCALL_SOURCE_URL = "https://github.com/anza-xyz/agave/blob/master/syscalls/src/lib.rs";

const SYSCALL_TIERS: { tier: Tier; label: string; explain: string; match: RegExp }[] = [
  { tier: "mythical", label: "BLS12-381 pairing crypto", explain: "Likely used here for aggregate signatures or advanced zero-knowledge proofs — the newest, rarest crypto on Solana.", match: /curve_pairing_map|curve_decompress/ },
  { tier: "legendary", label: "Pairing crypto (alt_bn128)", explain: "Likely used here to verify zero-knowledge proofs or aggregate signatures (BN254 pairing math).", match: /alt_bn128/ },
  { tier: "legendary", label: "ZK hashing (Poseidon)", explain: "Likely used here for hashing inside a zero-knowledge circuit — a strong tell the program does real ZK.", match: /poseidon/ },
  { tier: "epic", label: "Curve ops / ZK ElGamal", explain: "Likely used here for confidential balances or hidden amounts (curve25519 / ZK ElGamal).", match: /curve_/ },
  { tier: "epic", label: "secp256k1 recovery", explain: "Likely used here to verify Ethereum-style signatures — often a cross-chain bridge.", match: /secp256k1/ },
  { tier: "epic", label: "Big modular exponentiation", explain: "Likely used here for RSA-style signature or VDF verification.", match: /big_mod_exp/ },
  { tier: "rare", label: "SHA-512", explain: "Likely used here to hash or fingerprint on-chain data (512-bit).", match: /sha512/ },
  { tier: "rare", label: "Keccak-256", explain: "Likely used here for EVM-compatible hashing or address derivation.", match: /keccak/ },
  { tier: "rare", label: "BLAKE3", explain: "Likely used here for fast content hashing.", match: /blake3/ },
  { tier: "rare", label: "SHA-256", explain: "Likely used here to commit state or build Merkle proofs.", match: /sha256/ },
  { tier: "rare", label: "Epoch stake", explain: "Likely used here to read validator stake.", match: /epoch_stake/ },
  { tier: "rare", label: "Sibling instruction", explain: "Likely used here to inspect other instructions in the same transaction.", match: /sibling/ },
  { tier: "rare", label: "Last restart slot", explain: "Likely used here to detect cluster restarts.", match: /last_restart/ },
  { tier: "uncommon", label: "Return data", explain: "Likely used here to return values from a cross-program call.", match: /return_data/ },
  { tier: "uncommon", label: "Compute metering", explain: "Likely used here to guard its compute budget mid-execution.", match: /remaining_compute|stack_height/ },
  { tier: "uncommon", label: "Sysvar reads", explain: "Likely used here for time- or epoch-aware logic (clock, rent, epoch).", match: /sysvar|get_epoch/ },
  { tier: "uncommon", label: "PDA derivation", explain: "Likely used here to control its own program-owned accounts.", match: /program_address/ },
  { tier: "uncommon", label: "Cross-program calls", explain: "Likely used here to compose with other on-chain programs.", match: /invoke/ },
  { tier: "common", label: "Logging", explain: "Used here to emit transaction logs.", match: /log/ },
  { tier: "common", label: "Memory ops", explain: "Used here for low-level data handling.", match: /mem(cpy|move|set|cmp)/ },
  { tier: "common", label: "Allocator", explain: "Used here for heap allocation (a deprecated syscall).", match: /alloc_free/ },
  { tier: "common", label: "Panic / abort", explain: "Used here to abort on unrecoverable errors.", match: /panic|abort/ },
];

// Capability-level fallback for programs whose API response has no raw syscall
// vector yet (only the coarse capability set).
const CAP_TIERS: Record<string, { tier: Tier; label: string; explain: string }> = {
  "advanced-crypto": { tier: "epic", label: "Advanced cryptography", explain: "Likely used here for zero-knowledge proofs or signature aggregation." },
  hashing: { tier: "rare", label: "Hashing", explain: "Likely used here to commit state or build Merkle proofs." },
  "return-data": { tier: "uncommon", label: "Return data", explain: "Likely used here to return values from a cross-program call." },
  sysvars: { tier: "uncommon", label: "Sysvar reads", explain: "Likely used here for time- or epoch-aware logic." },
  cpi: { tier: "common", label: "Cross-program calls", explain: "Likely used here to compose with other on-chain programs." },
  pda: { tier: "common", label: "PDA derivation", explain: "Likely used here to control its own program-owned accounts." },
  tokens: { tier: "common", label: "Token handling", explain: "Likely used here to move SPL tokens." },
};

export interface Primitive {
  label: string;
  tier: Tier;
  explain: string; // one-line plain-English description
  syscalls: string[]; // the raw sol_* names behind it (empty on the capability fallback)
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
      const rule = SYSCALL_TIERS.find((r) => r.match.test(s));
      const label = rule?.label ?? "Other";
      const tier: Tier = rule?.tier ?? "common";
      const explain = rule?.explain ?? "An imported syscall.";
      const cur = byLabel.get(label) ?? { tier, explain, syscalls: [] };
      cur.syscalls.push(s);
      byLabel.set(label, cur);
    }
    items = [...byLabel.entries()].map(([label, v]) => ({ label, tier: v.tier, explain: v.explain, syscalls: v.syscalls }));
  } else {
    items = capabilities
      .map((c) => {
        const t = CAP_TIERS[c];
        return t ? { label: t.label, tier: t.tier, explain: t.explain, syscalls: [] as string[] } : null;
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
