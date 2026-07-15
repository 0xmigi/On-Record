// Radar URL state — the single source of truth for the radar page's query
// params. Every control (stream type, window, novelty tier, and the attribute
// facets) serializes through here so navigating one axis preserves the rest,
// and every link stays shareable (the whole point: a filtered radar is a URL
// you can paste into a tweet).

import type { ApiProgram, Category, Framework, Network, RadarType, RadarWindow } from "@/lib/api";

export type View = "novel" | "variant" | "recycled";
// Mirrors composition.ts SizeBand thresholds — kept local so the radar list
// (which only has sizeBytes, not a derived band) can bucket without importing
// the dossier-oriented composition module.
export type SizeBand = "lean" | "moderate" | "heavy";
// The rug-risk lens over authorityClass: frozen = immutable, multisig =
// Squads-governed, hot = one key can swap the code.
export type AuthorityFacet = "frozen" | "multisig" | "hot";

// Frameworks we let users filter by — "unknown" is the absence of a label, not
// a thing to select.
export const FILTER_FRAMEWORKS: Framework[] = ["anchor", "pinocchio", "native"];
export const SIZE_BANDS: SizeBand[] = ["lean", "moderate", "heavy"];
export const AUTHORITY_FACETS: AuthorityFacet[] = ["frozen", "multisig", "hot"];
// "unknown" is the absence of a category, not a selectable facet
export const FILTER_CATEGORIES: Category[] = ["defi", "token", "nft", "infra", "governance"];

export const SIZE_BAND_LABEL: Record<SizeBand, string> = {
  lean: "lean",
  moderate: "medium",
  heavy: "heavy",
};

export const SIZE_BAND_HINT: Record<SizeBand, string> = {
  lean: "under 64 KB",
  moderate: "64–256 KB",
  heavy: "256 KB and up",
};

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  anchor: "Anchor",
  pinocchio: "Pinocchio",
  native: "Native",
  unknown: "Unknown",
};

export const AUTHORITY_LABEL: Record<AuthorityFacet, string> = {
  frozen: "Frozen",
  multisig: "Multisig",
  hot: "Hot wallet",
};

export const AUTHORITY_HINT: Record<AuthorityFacet, string> = {
  frozen: "Immutable — the code can never change",
  multisig: "Upgrades gated by a Squads multisig",
  hot: "A single key can swap the code",
};

export const CATEGORY_FILTER_LABEL: Record<Category, string> = {
  defi: "DeFi",
  token: "Token",
  nft: "NFT",
  infra: "Infra",
  governance: "Gov",
  unknown: "Unknown",
};

/** The full radar query state, parsed and validated. */
export interface RadarParams {
  type: RadarType;
  window: RadarWindow;
  view?: View;
  network: Network;
  // attribute facets — compose with everything above (and each other)
  // status (multi-select toggles)
  verified: boolean;
  sectxt: boolean;
  idl: boolean;
  repo: boolean;
  active: boolean;
  // single-select groups
  authority: AuthorityFacet | null;
  category: Category | null;
  framework: Framework | null;
  size: SizeBand | null;
}

export function isView(v: string | undefined): v is View {
  return v === "novel" || v === "variant" || v === "recycled";
}

export function parseFramework(v: string | undefined): Framework | null {
  return v && (FILTER_FRAMEWORKS as string[]).includes(v) ? (v as Framework) : null;
}

export function parseSize(v: string | undefined): SizeBand | null {
  return v && (SIZE_BANDS as string[]).includes(v) ? (v as SizeBand) : null;
}

export function parseAuthority(v: string | undefined): AuthorityFacet | null {
  return v && (AUTHORITY_FACETS as string[]).includes(v) ? (v as AuthorityFacet) : null;
}

export function parseCategory(v: string | undefined): Category | null {
  return v && (FILTER_CATEGORIES as string[]).includes(v) ? (v as Category) : null;
}

/** Bucket a raw byte size into a band. Same thresholds as composition.ts. */
export function sizeBandOf(bytes: number | null): SizeBand | null {
  if (bytes == null) return null;
  if (bytes < 64 * 1024) return "lean";
  if (bytes < 256 * 1024) return "moderate";
  return "heavy";
}

/** Map a program's authorityClass onto the rug-risk facet, or null if it
 *  doesn't fit one of the three buckets (e.g. a program-owned authority). */
export function authorityFacetOf(program: ApiProgram): AuthorityFacet | null {
  switch (program.authorityClass) {
    case "none":
      return "frozen";
    case "squads":
      return "multisig";
    case "hot_wallet":
      return "hot";
    default:
      return null;
  }
}

export function programIsActive(program: ApiProgram): boolean {
  return (program.momentum?.txns24h ?? 0) > 0;
}

/** True when at least one attribute facet narrows the list. */
export function hasActiveFacets(p: RadarParams): boolean {
  return (
    p.verified ||
    p.sectxt ||
    p.idl ||
    p.repo ||
    p.active ||
    p.authority != null ||
    p.category != null ||
    p.framework != null ||
    p.size != null
  );
}

/** Does a program pass every active attribute facet? */
export function matchesFacets(program: ApiProgram, p: RadarParams): boolean {
  if (p.verified && !program.verified) return false;
  if (p.sectxt && !program.hasSecurityTxt) return false;
  if (p.idl && !program.idlPresent) return false;
  if (p.repo && !program.repoUrl) return false;
  if (p.active && !programIsActive(program)) return false;
  if (p.authority && authorityFacetOf(program) !== p.authority) return false;
  if (p.category && program.category !== p.category) return false;
  if (p.framework && program.framework !== p.framework) return false;
  if (p.size && sizeBandOf(program.sizeBytes) !== p.size) return false;
  return true;
}

/** Serialize a full param state to a radar href. Only non-default values are
 *  written, so the clean/default view stays at "/". */
export function buildRadarHref(p: RadarParams): string {
  const params = new URLSearchParams();
  if (p.type !== "deploy") params.set("type", p.type);
  if (p.window !== "today") params.set("window", p.window);
  if (p.view) params.set("view", p.view);
  // always emit the cluster: a persisted devnet cookie must not hijack an
  // explicit mainnet view (or vice-versa) when the next link omits it.
  params.set("network", p.network);
  if (p.verified) params.set("verified", "1");
  if (p.sectxt) params.set("sectxt", "1");
  if (p.idl) params.set("idl", "1");
  if (p.repo) params.set("repo", "1");
  if (p.active) params.set("active", "1");
  if (p.authority) params.set("authority", p.authority);
  if (p.category) params.set("category", p.category);
  if (p.framework) params.set("framework", p.framework);
  if (p.size) params.set("size", p.size);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/** Build an href that toggles/patches one axis while preserving the rest. */
export function withPatch(p: RadarParams, patch: Partial<RadarParams>): string {
  return buildRadarHref({ ...p, ...patch });
}
