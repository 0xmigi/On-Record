import type { ApiProgram } from "@/lib/api";

// ---------------------------------------------------------------------------
// The five visible signals (methodology v0 §5a: several explainable signals,
// never one opaque score). Every axis is a fixed, documented mapping of
// decoded on-chain facts — nothing inferred, nothing learned:
//
//   NEW    structural distance to the nearest known program (TLSH)
//   ACTIVE transactions in the last 24h, log₁₀ scale (10k+ caps the axis)
//   OPEN   how much the developer disclosed: name, repo, site, IDL,
//          security.txt, verified build — a count, out of 6
//   COST   SOL locked as rent by the deploy, log₁₀ scale (100 SOL caps)
//   CTRL   who can change it: multisig > frozen > program > hot wallet
//
// Each signal carries a plain-English `why` shown on hover — the sentence is
// the product; the shape is just its silhouette.
// ---------------------------------------------------------------------------

export interface Signal {
  key: string;
  label: string;
  value: number; // 0..1
  why: string;
}

export function deriveSignals(p: ApiProgram): Signal[] {
  const txns = p.momentum?.txns24h ?? p.earlySigners ?? 0;
  const activity = Math.min(1, Math.log10(1 + txns) / 4);

  const novelty =
    p.band === "clone"
      ? 0.05
      : p.nearest
        ? Math.max(0, 1 - p.nearest.similarity)
        : 1;

  const disclosed = [
    p.name,
    p.repoUrl,
    p.website ?? p.social,
    p.idlPresent,
    p.hasSecurityTxt,
    p.verified,
  ].filter(Boolean).length;

  const cost = Math.min(1, Math.log10(1 + (p.deployCostSol ?? 0)) / 2);

  const control = p.multisig
    ? 1
    : p.authorityClass === "none"
      ? 0.9
      : p.authorityClass === "program"
        ? 0.6
        : p.authorityClass === "hot_wallet"
          ? 0.25
          : 0.1;

  return [
    {
      key: "new",
      label: "NEW",
      value: novelty,
      why:
        p.band === "clone"
          ? "exact copy of known bytecode"
          : p.nearest
            ? `${Math.round(novelty * 100)}% structurally distinct from ${p.nearest.name ?? "its nearest relative"}`
            : "no known bytecode relative",
    },
    {
      key: "active",
      label: "ACTIVE",
      value: activity,
      why: `${txns.toLocaleString("en-US")} transactions in the last 24h`,
    },
    {
      key: "open",
      label: "OPEN",
      value: disclosed / 6,
      why: `${disclosed}/6 disclosures: name, repo, site, IDL, security.txt, verified build`,
    },
    {
      key: "cost",
      label: "COST",
      value: cost,
      why:
        p.deployCostSol != null
          ? `${p.deployCostSol} SOL locked as rent by the deploy`
          : "deploy cost unknown",
    },
    {
      key: "ctrl",
      label: "CTRL",
      value: control,
      why: p.multisig
        ? `Squads multisig${p.multisig.threshold != null ? ` (${p.multisig.threshold} of ${p.multisig.members} signers)` : ""}`
        : p.authorityClass === "none"
          ? "immutable — upgrade authority removed"
          : p.authorityClass === "program"
            ? "authority held by a program"
            : p.authorityClass === "hot_wallet"
              ? "single hot-wallet authority"
              : "authority unknown",
    },
  ];
}
