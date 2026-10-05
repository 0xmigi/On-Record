import type { MetadataRoute } from "next";

/**
 * Crawlers used to walk every program page on a loop: about nine renders a
 * minute, each a full dynamic server render, which is what was spending the
 * Vercel CPU allowance. Dossiers are cached now (revalidate in
 * app/p/[id]/page.tsx), so a crawl mostly hits the cache.
 *
 * Program pages are open to the two search engines that send people here, and
 * still closed to everyone else. Opaque dossiers are crawlable but `noindex`
 * (lib/indexable.ts); the sitemap lists only the ones worth a result.
 *
 * This only stops well-behaved bots. Scrapers that ignore robots.txt need
 * Vercel's bot protection on the project.
 */
export default function robots(): MetadataRoute.Robots {
  const closed = ["/api/", "/admin/", "/saved", "/search"];
  return {
    rules: [
      { userAgent: ["Googlebot", "Bingbot"], allow: "/", disallow: closed },
      { userAgent: "*", disallow: ["/p/", ...closed] },
    ],
    sitemap: "https://on-record.azuolas.xyz/sitemap.xml",
  };
}
