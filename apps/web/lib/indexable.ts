import type { ApiProgram } from "@/lib/api";

/**
 * Whether a dossier should be in search results. Open mainnet programs with
 * some identity — a name (usually the leaked crate), verification, a published
 * IDL, or a declared repo. Those pages carry facts no explorer shows.
 *
 * The rest stay crawlable but `noindex`: 93% of deploys are opaque, and
 * thousands of near-identical pages would cost the site more standing than
 * they earn. Calibrated 2026-10-05: 4,537 of 7,395 open mainnet programs pass.
 *
 * Must match the SQL in the API's /api/sitemap (apps/ingest/src/routes/public.ts).
 */
export function isIndexable(p: ApiProgram): boolean {
  if (p.network !== "mainnet" || p.closed) return false;
  return Boolean(p.name || p.verified || p.idlPresent || p.repoUrl || p.repoUrlDeclared);
}
