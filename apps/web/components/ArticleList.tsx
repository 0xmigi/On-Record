import Link from "next/link";
import { dayStamp } from "@/lib/format";
import type { Article } from "@/lib/writing";

/** A plain list of articles: title, date, one line. Used by /writing and by a
 *  tool page's Related section. */
export function ArticleList({ articles }: { articles: Article[] }) {
  return (
    <ul className="article-list">
      {articles.map((a) => (
        <li key={a.slug}>
          <Link href={`/writing/${a.slug}`} className="article-list-title">
            {a.title}
          </Link>
          <span className="article-list-meta">{dayStamp(a.date)}</span>
          {a.description ? <p className="article-list-desc">{a.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}
