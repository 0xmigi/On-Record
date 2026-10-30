import type { MetadataRoute } from "next";

/**
 * Crawlers used to walk every program page on a loop: about nine renders a
 * minute, each a full dynamic server render, which is what was spending the
 * Vercel CPU allowance. Dossiers are cached now (revalidate in
 * app/p/[id]/page.tsx), so a crawl mostly hits the cache.
 *
 * Program pages are open to search engines and to the AI assistants' search
 * and fetch-on-request agents — the ones that put a page in an answer with a
 * link. Everyone else, model-training crawlers included, still stays off /p/
 * and gets the home, method and llms.txt pages only. Opaque dossiers are
 * crawlable but `noindex` (lib/indexable.ts); the sitemap lists only the ones
 * worth a result.
 *
 * This only stops well-behaved bots. Scrapers that ignore robots.txt need
 * Vercel's bot protection on the project.
 */
const SEARCH = ["Googlebot", "Bingbot"];
const ANSWER_ENGINES = [
  "OAI-SearchBot", // ChatGPT search
  "ChatGPT-User", // ChatGPT fetching a page a user asked about
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
];
// Link-preview bots fetch a page only when someone shares its link, and they
// honour robots.txt: blocking /p/ for them means no card on X, Slack etc. Same
// list as the "Link preview bots pass" rule in the Vercel firewall.
const LINK_PREVIEWS = [
  "Twitterbot",
  "facebookexternalhit",
  "Slackbot",
  "Discordbot",
  "TelegramBot",
  "LinkedInBot",
];

export default function robots(): MetadataRoute.Robots {
  const closed = ["/api/", "/admin/", "/saved", "/search"];
  return {
    rules: [
      { userAgent: [...SEARCH, ...ANSWER_ENGINES, ...LINK_PREVIEWS], allow: "/", disallow: closed },
      { userAgent: "*", disallow: ["/p/", ...closed] },
    ],
    sitemap: "https://on-record.azuolas.xyz/sitemap.xml",
  };
}
