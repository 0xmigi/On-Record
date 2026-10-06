import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Ash's writing that isn't about one program — dev topics like verification.
 * Program write-ups live on their program's page instead.
 *
 * One markdown file per article in content/writing/<slug>.md, with a small
 * front matter block:
 *
 *   ---
 *   title: …
 *   date: 2026-10-02
 *   description: one line for search results and the article lists
 *   topic: verification        ← ties it to a tool page's "Related" section
 *   image: /path/to/share.png  ← optional
 *   x: https://x.com/…         ← optional, where it was first posted
 *   note: figures from 28 Sep  ← optional, shown in the byline
 *   ---
 *
 * Read at build time; every page that uses this is static.
 */

export interface Article {
  slug: string;
  title: string;
  date: string;
  description: string;
  topic: string | null;
  image: string | null;
  x: string | null;
  note: string | null;
  body: string;
}

/** where a topic's tool lives, for the link at the end of an article */
export const TOPIC_TOOL: Record<string, { href: string; label: string }> = {
  verification: { href: "/verification", label: "Get verification alerts" },
};

const DIR = join(process.cwd(), "content/writing");

function parse(slug: string, raw: string): Article {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`content/writing/${slug}.md has no front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.title || !meta.date) throw new Error(`content/writing/${slug}.md needs a title and a date`);
  return {
    slug,
    title: meta.title,
    date: meta.date,
    description: meta.description ?? "",
    topic: meta.topic ?? null,
    image: meta.image ?? null,
    x: meta.x ?? null,
    note: meta.note ?? null,
    body: raw.slice(m[0].length),
  };
}

export function allArticles(): Article[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parse(f.slice(0, -3), readFileSync(join(DIR, f), "utf8")))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getArticle(slug: string): Article | null {
  return allArticles().find((a) => a.slug === slug) ?? null;
}

export function articlesFor(topic: string): Article[] {
  return allArticles().filter((a) => a.topic === topic);
}
