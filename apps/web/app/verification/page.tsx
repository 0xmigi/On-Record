import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { Markdown } from "@/lib/markdown";

/**
 * The home of On Record's verification work. Today it is Ash's article, as
 * posted on X; the alerts sign-up lands here next (research/verification-feed-plan.md).
 * The text lives in content/verification.md — edit it there, not here.
 */
export const dynamic = "force-static";

const TITLE = "Where are the verified builds on Solana?";
const PUBLISHED = "2026-10-02";
const X_POST = "https://x.com/0xmigi/status/2106074745976603016";
const SITE = "https://on-record.azuolas.xyz";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "1 in 40 live Solana programs has a verified build. Why that is, using on-chain data, and how to verify your builds reliably when you deploy and upgrade.",
  alternates: { canonical: "/verification" },
  authors: [{ name: "migi", url: "https://x.com/0xmigi" }],
  openGraph: {
    type: "article",
    title: TITLE,
    publishedTime: PUBLISHED,
    images: [{ url: "/verification/grid.png", width: 1660, height: 1326 }],
  },
};

const source = readFileSync(join(process.cwd(), "content/verification.md"), "utf8");

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: TITLE,
  datePublished: PUBLISHED,
  author: { "@type": "Person", name: "migi", url: "https://x.com/0xmigi" },
  image: `${SITE}/verification/grid.png`,
  mainEntityOfPage: `${SITE}/verification`,
  sameAs: X_POST,
};

export default function VerificationPage() {
  return (
    <article className="essay">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>{TITLE}</h1>
      <p className="essay-meta">
        <a href="https://x.com/0xmigi" target="_blank" rel="noopener noreferrer">
          migi
        </a>{" "}
        · 2 Oct 2026 · figures from 28 Sep ·{" "}
        <a href={X_POST} target="_blank" rel="noopener noreferrer">
          on X
        </a>
      </p>
      <Markdown source={source} />
      <p className="essay-meta essay-live">
        Live on the radar:{" "}
        <Link href="/?type=upgrade&window=all&verified=lost">lost verification</Link> ·{" "}
        <Link href="/?type=upgrade&window=all&verified=1">verified</Link>
      </p>
    </article>
  );
}
