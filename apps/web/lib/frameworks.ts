import type { Framework } from "@/lib/api";

// ---------------------------------------------------------------------------
// Framework knowledge base — the developer-learning layer. Each entry is a
// compact, accurate profile of a Solana program framework: what it is, the
// on-chain trade-off it makes, and — crucially — how (un)reliably it can be
// recognized from the deployed binary. On Record is on-chain-first and honest
// about its labels, so detectability is a first-class field, not a footnote.
// ---------------------------------------------------------------------------

export type Confidence = "confirmed" | "inferred";

export interface FrameworkInfo {
  key: Framework;
  label: string;
  /** One-line positioning — the sensible version of a "difficulty" tag. It's a
   *  property of the framework, not the program. */
  positioning: string;
  /** What the choice signals about the program (headline summary). */
  read: string;
  /** The on-chain trade-off the choice makes. */
  tradeoff: string;
  /** How we recognize it in the binary — written honestly. */
  detection: string;
  /** Long-form "What's X?" explainer (the Orb-style collapsible). */
  explainer: {
    author: string;
    whatIs: string;
    whenToPick: string;
    onChain: string;
    docsUrl?: string;
  };
}

// Whether the framework can be *positively* fingerprinted on-chain. Only Anchor
// enforces a layout (discriminators + IDL) that proves what built it; everyone
// else is inference from binary shape.
export const DETECTION_RELIABLE: Record<Framework, boolean> = {
  anchor: true,
  pinocchio: false,
  native: false,
  unknown: false,
};

export const FRAMEWORK_INFO: Record<Framework, FrameworkInfo> = {
  anchor: {
    key: "anchor",
    label: "Anchor",
    positioning: "ecosystem standard · beginner-friendly",
    read: "Batteries-included Rust framework. Ships account-validation codegen, 8-byte instruction discriminators, and an on-chain IDL — the program describes itself.",
    tradeoff:
      "Bigger binary and higher rent in exchange for safety rails, introspection, and dev speed. The choice of a team optimizing for correctness over on-chain footprint.",
    detection:
      "Confirmed — the binary carries Anchor's error table (AnchorError, Constraint* messages) and IDL-account machinery. Anchor is the one framework reliably identifiable on-chain.",
    explainer: {
      author: "Originally Coral (Armani Ferrante); now community-maintained.",
      whatIs:
        "The de facto standard. Rust macros (#[program], #[derive(Accounts)]) eliminate boilerplate: it auto-generates 8-byte account and instruction discriminators — SHA256(\"account:<Name>\")[..8] and SHA256(\"global:<ix>\")[..8] — handles Borsh (de)serialization, enforces account constraints declaratively (mut, has_one, seeds, init), and emits a JSON IDL that client libraries consume directly. The cost: Borsh copies data on every deserialize (not zero-copy), and the macro machinery adds binary bloat and compute overhead — irrelevant for ~99% of programs.",
      whenToPick:
        "Building a new protocol, moving fast, or wanting maximum ecosystem compatibility. It's the beginner default and stays the right call for most production programs.",
      onChain:
        "The most recognizable framework. Every account it owns begins with an 8-byte discriminator, and the IDL is often published on-chain at a PDA derived from the program id. Both are strong, reliable fingerprints — this is the only framework we can label with confidence.",
      docsUrl: "https://www.anchor-lang.com",
    },
  },
  pinocchio: {
    key: "pinocchio",
    label: "Pinocchio",
    positioning: "performance · hot-path · advanced",
    read: "Zero-dependency, no-std entrypoint. No codegen, no IDL — the developer hand-writes account parsing against the raw C ABI (sol_invoke_signed_c).",
    tradeoff:
      "Tiny binary and low compute-unit cost, at the price of manual safety and no self-description. The choice for a hot path — routing, MEV, high-frequency — where every CU and lamport of rent is optimized.",
    detection:
      "Inferred — the program invokes the C ABI (sol_invoke_signed_c) and ships no framework markers, which fits Pinocchio. But native and Steel programs can look the same; treat this as a strong hint, not proof.",
    explainer: {
      author: "Built by Anza (the Agave client team).",
      whatIs:
        "A drop-in replacement for the solana-program crate — not an Anchor-style framework. Its core innovation is zero-copy AccountInfo: instead of deserializing account data into an owned struct, it returns a pointer directly into the input buffer, eliminating a major class of memory copies and cutting CU usage on hot instructions. It has zero external dependencies and is no_std. It's completely unopinionated — no IDL, no account-validation helpers, no standard layout — so you bring Shank + Codama to generate IDLs and clients yourself. Still unaudited and not at full feature parity with solana-program.",
      whenToPick:
        "Programs that process enormous volume where CU cost is the bottleneck — token programs, AMM hot paths, Ore-style mining. Not beginner-friendly.",
      onChain:
        "No enforced discriminator or account layout, and no on-chain IDL — so it can't be positively identified from account data. The tiny, dependency-free binary is the main tell, which is why we label it 'inferred'.",
      docsUrl: "https://github.com/anza-xyz/pinocchio",
    },
  },
  native: {
    key: "native",
    label: "Native",
    positioning: "no abstraction · advanced",
    read: "Built directly on the solana-program SDK with no framework layer. Bespoke account handling and dispatch.",
    tradeoff:
      "Footprint sits between Anchor and Pinocchio. The choice of a developer who wants control without Anchor's overhead and doesn't need its guardrails.",
    detection:
      "Inferred — Solana syscalls with none of Anchor's or a known framework's markers. Native, Steel, and other minimal setups are hard to tell apart from the binary alone.",
    explainer: {
      author: "Raw Rust against the official solana-program crate.",
      whatIs:
        "No framework. You handle account deserialization, discriminators, security checks, CPI construction, and IDL generation yourself. Maximum control, maximum verbosity, and no abstraction overhead.",
      whenToPick:
        "A small utility program, tooling, or when you have a specific reason to avoid all dependencies. Few new production protocols start here from scratch.",
      onChain:
        "No enforced layout — nothing to fingerprint. Indistinguishable from other minimal frameworks (Steel, hand-rolled setups) by account data alone.",
      docsUrl: "https://docs.rs/solana-program",
    },
  },
  unknown: {
    key: "unknown",
    label: "Unknown",
    positioning: "unrecognized toolchain",
    read: "No Anchor or Pinocchio markers in the binary, and a stripped or unusual symbol table.",
    tradeoff:
      "Framework can't be read off the ELF — either heavily stripped, a niche framework, or a non-Rust toolchain.",
    detection:
      "Not identified — no framework signature we recognize survived in the binary.",
    explainer: {
      author: "Unknown toolchain.",
      whatIs:
        "The binary didn't carry a framework signature we recognize — no Anchor error table, no Pinocchio C-ABI tell, and no readable symbols to work from.",
      whenToPick:
        "Not applicable — this is a detection gap, not a developer choice.",
      onChain:
        "Nothing to fingerprint. Could be a stripped build, a niche or new framework, or a non-Rust toolchain.",
    },
  },
};

// Frameworks we don't classify yet — surfaced in the explainer so the page
// reads as a complete learning resource, and so the detection limits are honest.
export const OTHER_FRAMEWORKS_NOTE =
  "Others in the wild: Steel (Ore team — near-native performance on solana-program), Seahorse (Python → Anchor), and Poseidon & Quasar (TypeScript → Rust). Transpilers inherit their lowering target's fingerprint: a Quasar or Poseidon program that compiles down to Anchor will look like Anchor on-chain — discriminators and all.";
