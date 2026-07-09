import type { Category, Fingerprint, Identity } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Rule-based category tag (SPEC §4). Zero LLM. Derives a coarse category from
// the published IDL instruction names, then falls back to printable strings.
// `unknown` is a valid, honest answer — we never guess in prose.
// ---------------------------------------------------------------------------

const RULES: { category: Category; needles: string[] }[] = [
  {
    category: "defi",
    needles: [
      "swap",
      "addliquidity",
      "removeliquidity",
      "deposit",
      "withdraw",
      "borrow",
      "repay",
      "lend",
      "stake",
      "unstake",
      "perp",
      "amm",
      "pool",
      "vault",
      "collateral",
      "liquidat",
      "openposition",
    ],
  },
  {
    category: "nft",
    needles: [
      "metadata",
      "mastered", // masterEdition
      "masteredition",
      "collection",
      "candymachine",
      "candy_machine",
      "mintnft",
      "verifycreator",
      "editionmarker",
    ],
  },
  {
    category: "governance",
    needles: ["proposal", "governance", "realm", "castvote", "dao", "quorum", "council"],
  },
  {
    category: "infra",
    needles: [
      "oracle",
      "pricefeed",
      "pyth",
      "bridge",
      "relayer",
      "registry",
      "verify",
      "attestation",
      "messagetransmitter",
    ],
  },
  {
    category: "token",
    needles: ["minttoken", "transferchecked", "createmint", "tokenmint", "initializemint", "burnchecked"],
  },
];

export function categorize(fp: Fingerprint | undefined, identity: Identity | undefined): Category {
  // an identified entity's own category wins if we seeded one
  const entityCat = normalizeEntityCategory(identity);
  if (entityCat) return entityCat;

  const haystack = buildHaystack(fp);
  if (!haystack) return "unknown";

  const scores = new Map<Category, number>();
  for (const rule of RULES) {
    let hits = 0;
    for (const needle of rule.needles) if (haystack.includes(needle)) hits++;
    if (hits > 0) scores.set(rule.category, hits);
  }
  if (scores.size === 0) return "unknown";
  // highest hit count wins; ties resolve by RULES order (defi → nft → …)
  let best: Category = "unknown";
  let bestHits = 0;
  for (const rule of RULES) {
    const h = scores.get(rule.category) ?? 0;
    if (h > bestHits) {
      bestHits = h;
      best = rule.category;
    }
  }
  return best;
}

function buildHaystack(fp: Fingerprint | undefined): string {
  if (!fp) return "";
  const parts: string[] = [];
  if (fp.idl) {
    parts.push(...fp.idl.instructions, ...fp.idl.accounts);
  }
  // strings are a weaker fallback — only scanned when there's no IDL surface
  if (!fp.idl && fp.strings) parts.push(...fp.strings.slice(0, 200));
  return parts.join(" ").toLowerCase().replace(/[_\s]/g, "");
}

function normalizeEntityCategory(identity: Identity | undefined): Category | null {
  if (!identity?.entityId) return null;
  // entities carry a freeform category string; map the common ones
  return null; // entity category mapping handled at seed time; default off
}
