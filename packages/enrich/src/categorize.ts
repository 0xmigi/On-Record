import type { Category, Fingerprint, Identity, ProgramProfile } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Rule-based category tag (SPEC §4). Zero LLM. `unknown` is a valid, honest
// answer — we never guess in prose, and we don't guess here either.
//
// WHAT CHANGED, AND WHY
//
// The old version scanned the IDL, then fell back to the first 200 printable
// strings in the binary. Measured over the whole mainnet corpus (4,190
// programs) that put 2,349 in `defi` and, on the 235 programs a public curated
// list also covers, 195 of 235 — 83% — in that one bucket. A filter where five
// of every six rows share a value is not a filter.
//
// Two causes, both fixed here.
//
//   1. THE WRONG EVIDENCE. A program's printable strings are mostly its
//      DEPENDENCIES talking: every Anchor program carries Metaplex metadata
//      vocabulary, every token-touching program carries the SPL token
//      vocabulary. Classifying deBridge as `nft` because its binary mentions
//      `collection` is the same failure `DEP_REPO_ORGS` guards against in
//      identity.ts. So we classify from `profile.instructionNames` — the
//      program's OWN entry points — and only when they came from a source that
//      is actually a list of entry points (`idl`, `anchor-log`). The
//      `debug-enum` source recovers error variants ("AlignmentMismatch",
//      "WrongSize"), which name nothing the program does.
//
//   2. THE WRONG ARITHMETIC. Scoring by hit COUNT with ties broken by rule
//      order handed everything to `defi`, whose needle list was both the
//      longest and the most generic — `deposit`, `withdraw`, `pool`, `vault`
//      appear in nearly every finance program. Needles are weighted now, so
//      `liquidateObligation` outranks a passing `deposit`, and `defi` is a
//      low-weight fallback rather than a magnet.
//
// CALIBRATION (2026-08-03, whole corpus + the 235-program public overlap):
// where these rules commit to a category they agree with that list 71% of the
// time, against a 61% first cut. The residue is real disagreement, not error —
// yield farms sit genuinely between `staking` and `defi`, and we call Meteora's
// Dynamic Bonding Curve program `launchpad` off its bonding-curve instructions
// where the list says Swap. Agreement is a sanity check, not the target: that
// list encodes business knowledge (it knows which address belongs to Bitget)
// that no amount of bytecode reading recovers — which is what the registry
// fallback in normalizeEntityCategory is for, on the programs whose code says
// nothing at all.
// ---------------------------------------------------------------------------

/** Weighted needles, matched against the lowercased, separator-stripped
 *  instruction surface. Weight = how much this verb alone should count; a
 *  6 is a term that essentially only occurs in that domain, a 1–2 is shared
 *  vocabulary that only counts as corroboration. */
const RULES: { category: Category; needles: Record<string, number> }[] = [
  {
    category: "perps",
    needles: {
      fundingrate: 6, settlepnl: 6, liquidateperp: 6, perpmarket: 6, placeperporder: 6,
      openposition: 5, closeposition: 5, increaseposition: 5, decreaseposition: 5,
      perpetual: 5, insurancefund: 5, perp: 4, marginaccount: 4, leverage: 3,
    },
  },
  {
    category: "lending",
    needles: {
      liquidateobligation: 6, refreshobligation: 6, initobligation: 6,
      flashloan: 5, obligation: 5, redeemreserve: 5, refreshreserve: 5, initreserve: 5,
      borrow: 4, repay: 4, collateral: 2,
    },
  },
  {
    category: "launchpad",
    needles: {
      bondingcurve: 6, graduate: 6, migratetoamm: 6, migratemeteora: 6, migrateraydium: 6,
      presale: 5, launchpool: 4, createtoken: 3, buyexactin: 3, sellexactin: 3,
    },
  },
  {
    category: "bridge",
    needles: {
      messagetransmitter: 6, postvaa: 6, receivemessage: 6, crosschain: 6,
      depositforburn: 6, quoteremote: 6, externalcallstorage: 6, claimunlock: 5,
      bridge: 4, postmessage: 3, guardian: 3, relayer: 2, attestation: 2,
    },
  },
  {
    category: "oracle",
    needles: {
      pricefeed: 6, priceupdate: 6, aggregatorround: 6, postprice: 6, submitprice: 6,
      pushprice: 6, pullfeed: 6, createfeed: 6, closefeed: 6, writeprice: 6,
      uniquesignerscount: 6, updatefeed: 5, oracle: 4,
    },
  },
  {
    category: "staking",
    needles: {
      delegatestake: 6, stakepool: 6, depositstake: 6, withdrawstake: 6, restake: 6,
      unstake: 5, undelegate: 5, harvest: 3, farm: 3, stake: 3, validator: 2, claimrewards: 2,
    },
  },
  {
    category: "dex",
    needles: {
      tickarray: 6, addliquidity: 5, removeliquidity: 5, increaseliquidity: 5,
      decreaseliquidity: 5, swapexact: 5, sharedaccountsroute: 5, exactoutroute: 5,
      routeplan: 5, swap: 4, initializepool: 3, exchange: 3, route: 3,
      placeorder: 2, cancelorder: 2, collectfees: 2,
    },
  },
  {
    category: "nft",
    needles: {
      masteredition: 6, candymachine: 6, verifycreator: 6, editionmarker: 6,
      mintnft: 6, verifycollection: 6, whitelist: 3, collection: 2, metadata: 2,
    },
  },
  {
    category: "governance",
    needles: { castvote: 6, realm: 6, quorum: 6, votingmint: 6, proposal: 3, governance: 3, council: 3 },
  },
  {
    category: "airdrop",
    needles: { merkledistributor: 6, claimairdrop: 6, newdistributor: 6, merkleproof: 4, distributor: 3 },
  },
  {
    category: "token",
    needles: { initializemint: 6, transferchecked: 6, burnchecked: 6, createmint: 3, mintto: 3 },
  },
  {
    category: "infra",
    needles: {
      multisig: 6, namerecord: 6, verifybuild: 6, squads: 6, createlookuptable: 6,
      tipdistribution: 6, createvalidatormanager: 6,
      addmember: 5, removemember: 5, changethreshold: 5, recoverysigner: 5,
      registry: 3, attest: 2,
    },
  },
  // last resort: finance-shaped, nothing more specific survived
  {
    category: "defi",
    needles: { vault: 2, treasury: 2, compound: 2, deposit: 1, withdraw: 1, fee: 1 },
  },
];

/** Below this, the only matches were shared vocabulary — not evidence. */
const MIN_SCORE = 3;

/** Only the registry fields are read, so callers that have just looked an
 *  entity up do not have to fabricate a whole Identity. */
type EntityRef = Pick<Identity, "entityId" | "entityCategory">;

export function categorize(
  fp: Fingerprint | undefined,
  identity: EntityRef | undefined,
  profile?: ProgramProfile,
): Category {
  // The program's own instructions come first, and the registry backs them up.
  //
  // The other order is tempting — somebody curated the registry, so let it win
  // — and it is wrong, because a registry category describes an ENTITY and an
  // entity is not one thing. Jupiter is filed under `dex`; Jupiter also ships a
  // perps engine, two lend programs and a governance program, and letting the
  // entity decide labelled every one of them `dex` while their own instruction
  // surfaces said perps, lending and governance. The registry knows who built
  // it; the bytecode knows what it does. Only when the bytecode says nothing
  // does who-built-it become the best available answer.
  const hay = surface(profile, fp);
  if (!hay) return normalizeEntityCategory(identity) ?? "unknown";

  let best: Category = "unknown";
  let bestScore = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const [needle, weight] of Object.entries(rule.needles)) {
      if (hay.includes(needle)) score += weight;
    }
    // ties keep the earlier (more specific) rule, as ordered above
    if (score > bestScore) {
      bestScore = score;
      best = rule.category;
    }
  }
  return bestScore >= MIN_SCORE ? best : (normalizeEntityCategory(identity) ?? "unknown");
}

/** The program's own instruction vocabulary, normalised for substring matching.
 *
 *  Only entry-point sources count. `debug-enum` recovers error variants, and
 *  raw binary strings are mostly dependency vocabulary — both produced
 *  confident, wrong answers (deBridge as `nft`, the Address Lookup Table
 *  program as `lending`). Having no usable surface is a real state, and the
 *  honest label for it is `unknown`. */
function surface(profile: ProgramProfile | undefined, fp: Fingerprint | undefined): string {
  const src = profile?.instructionSource;
  const names =
    src === "idl" || src === "anchor-log"
      ? (profile?.instructionNames ?? [])
      : // no profile yet (older rows, re-runs before a re-profile) — the IDL
        // itself is the same evidence by another route
        (fp?.idl?.instructions ?? []);
  if (!names.length) return "";
  return names.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Registry categories are freeform strings written by an operator in
 *  labels.yaml; this maps them onto the enum. Used as the fallback when the
 *  bytecode offers no instruction surface to read — see categorize() for why
 *  it backs the rules up rather than overriding them.
 *
 *  This used to be `return null` under a comment claiming entity categories
 *  were "handled at seed time". They were not: every category in labels.yaml
 *  was written to the entities table and then read by nothing. */
export function normalizeEntityCategory(identity: EntityRef | undefined): Category | null {
  if (!identity?.entityId) return null;
  return mapCategory(identity.entityCategory);
}

/** labels.yaml vocabulary → Category. Unknown strings return null rather than
 *  a guess, so a typo in the registry falls through to the rules instead of
 *  silently mislabelling every program the entity owns. */
export function mapCategory(raw: string | null | undefined): Category | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[^a-z]/g, "");
  const map: Record<string, Category> = {
    dex: "dex", amm: "dex", swap: "dex", dexaggregator: "dex", aggregator: "dex",
    clmm: "dex", orderbook: "dex",
    perps: "perps", perpetuals: "perps", derivatives: "perps",
    lending: "lending", borrowlend: "lending", moneymarket: "lending",
    staking: "staking", liquidstaking: "staking", restaking: "staking", stakepool: "staking",
    launchpad: "launchpad", tokenlaunch: "launchpad",
    bridge: "bridge", crosschainbridge: "bridge", crosschain: "bridge", interop: "bridge",
    oracle: "oracle", pricefeed: "oracle",
    nft: "nft", nftmarketplace: "nft", nftinfra: "nft", marketplace: "nft", compression: "nft",
    governance: "governance", dao: "governance",
    airdrop: "airdrop", distribution: "airdrop",
    token: "token", tokenstandard: "token",
    infra: "infra", infrastructure: "infra", tools: "infra", multisig: "infra",
    native: "infra", wallet: "infra", payments: "infra",
    defi: "defi", yield: "defi", vault: "defi", rwa: "defi",
  };
  return map[s] ?? null;
}
