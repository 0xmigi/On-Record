import type { Metadata } from "next";
import { ArticleList } from "@/components/ArticleList";
import { allArticles } from "@/lib/writing";

export const metadata: Metadata = {
  title: "Writing",
  description: "Articles on building Solana programs, from what On Record sees on chain.",
  alternates: { canonical: "/writing" },
};

export default function WritingPage() {
  return (
    <div className="essay">
      <h1>Writing</h1>
      <ArticleList articles={allArticles()} />
    </div>
  );
}
