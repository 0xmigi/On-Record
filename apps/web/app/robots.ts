import type { MetadataRoute } from "next";

/**
 * Crawlers were walking every program page on a loop: about nine renders a
 * minute, each a full dynamic server render, which is what was spending the
 * Vercel CPU allowance. The dossiers are for people who arrive with an
 * address in hand, not for search, so bots are kept off `/p/` entirely. The
 * radar, method and home pages stay open.
 *
 * This only stops well-behaved bots. Scrapers that ignore robots.txt need
 * Vercel's bot protection on the project.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: ["/p/", "/api/", "/admin/"] }],
  };
}
