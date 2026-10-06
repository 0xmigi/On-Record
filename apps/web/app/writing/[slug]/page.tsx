import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dayStamp } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { TOPIC_TOOL, allArticles, getArticle } from "@/lib/writing";

// One article from content/writing/. Static: every slug is known at build time.
export const dynamicParams = false;
export function generateStaticParams() {
  return allArticles().map((a) => ({ slug: a.slug }));
}

const SITE = "https://on-record.azuolas.xyz";
const AUTHOR = { name: "migi", url: "https://x.com/0xmigi" };

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const a = getArticle((await params).slug);
  if (!a) return {};
  return {
    title: a.title,
    description: a.description,
    alternates: { canonical: `/writing/${a.slug}` },
    authors: [AUTHOR],
    openGraph: {
      type: "article",
      title: a.title,
      publishedTime: a.date,
      ...(a.image ? { images: [{ url: a.image }] } : {}),
    },
  };
}

export default async function ArticlePage({ params }: { params: Params }) {
  const a = getArticle((await params).slug);
  if (!a) notFound();
  const tool = a.topic ? TOPIC_TOOL[a.topic] : undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    datePublished: a.date,
    author: { "@type": "Person", ...AUTHOR },
    mainEntityOfPage: `${SITE}/writing/${a.slug}`,
    ...(a.image ? { image: `${SITE}${a.image}` } : {}),
    ...(a.x ? { sameAs: a.x } : {}),
  };

  return (
    <article className="essay">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>{a.title}</h1>
      <p className="essay-meta">
        <a href={AUTHOR.url} target="_blank" rel="noopener noreferrer">
          {AUTHOR.name}
        </a>{" "}
        · {dayStamp(a.date)}
        {a.note ? ` · ${a.note}` : ""}
        {a.x ? (
          <>
            {" "}
            ·{" "}
            <a href={a.x} target="_blank" rel="noopener noreferrer">
              on X
            </a>
          </>
        ) : null}
      </p>
      <Markdown source={a.body} />
      <p className="essay-meta essay-live">
        {tool ? (
          <>
            <Link href={tool.href}>{tool.label} →</Link> ·{" "}
          </>
        ) : null}
        <Link href="/writing">More writing</Link>
      </p>
    </article>
  );
}
