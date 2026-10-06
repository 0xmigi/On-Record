import type { MetadataRoute } from "next";
import { fetchSitemap } from "@/lib/api";
import { allArticles } from "@/lib/writing";

const SITE = "https://on-record.azuolas.xyz";

// rebuilt hourly; new programs reach search through this, not through crawling
// the radar
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = [
    { url: SITE, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE}/methodology`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE}/funnel`, changeFrequency: "daily", priority: 0.5 },
    { url: `${SITE}/verification`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE}/writing`, changeFrequency: "weekly", priority: 0.6 },
    ...allArticles().map((a) => ({
      url: `${SITE}/writing/${a.slug}`,
      lastModified: a.date,
      changeFrequency: "monthly" as const,
      priority: 0.9,
    })),
  ];
  // An API outage must not fail the build or blank the sitemap's static pages.
  let programs: Awaited<ReturnType<typeof fetchSitemap>> = [];
  try {
    programs = await fetchSitemap();
  } catch {
    programs = [];
  }
  return [
    ...pages,
    ...programs.map((p) => ({
      url: `${SITE}/p/${p.id}`,
      lastModified: p.lastEventAt ?? undefined,
    })),
  ];
}
