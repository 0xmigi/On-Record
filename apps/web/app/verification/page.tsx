import type { Metadata } from "next";
import Link from "next/link";
import { AlertSignup } from "@/components/AlertSignup";
import { ArticleList } from "@/components/ArticleList";
import { articlesFor } from "@/lib/writing";

/**
 * Verification alerts: the tool. The writing behind it lives in /writing and
 * shows up here as Related (anything tagged `topic: verification`).
 * Plan: research/verification-feed-plan.md.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Verification alerts for Solana programs",
  description:
    "Get notified when your Solana program's verification fails, with the reason and the fix.",
  alternates: { canonical: "/verification" },
};

export default function VerificationPage() {
  const related = articlesFor("verification");
  return (
    <div className="essay">
      <h1>Verification alerts</h1>
      <p className="tool-lede">
        Paste your deploy address. Get alerted when an upgrade breaks your verification.
      </p>
      {/* a fixed-height stage, so the program list growing never moves what's below */}
      <section className="tool-main">
        <AlertSignup />
        <p className="essay-meta">
          On the radar: <Link href="/?type=upgrade&window=all&verified=lost">lost verification</Link> ·{" "}
          <Link href="/?type=upgrade&window=all&verified=1">verified</Link>
        </p>
      </section>
      {related.length ? (
        <section className="related">
          <h2 className="related-title">Writing on verification</h2>
          <ArticleList articles={related} />
        </section>
      ) : null}
    </div>
  );
}
