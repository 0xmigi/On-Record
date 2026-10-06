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
    <div>
      <h1 className="funnel-title">Verification alerts</h1>
      <p className="tool-lede">
        Paste your deploy address. Get alerted when an upgrade breaks your verification.
      </p>
      {/* the tool in the main column; reading and radar links beside it, so the
          program list can grow without moving anything */}
      <div className="tool-layout">
        <section className="tool-main">
          <AlertSignup />
        </section>
        <aside className="tool-aside">
          <section>
            <h2 className="related-title">On the radar</h2>
            <ul className="tool-aside-links">
              <li>
                <Link href="/?type=upgrade&window=all&verified=lost">Lost verification</Link>
              </li>
              <li>
                <Link href="/?type=upgrade&window=all&verified=1">Verified programs</Link>
              </li>
            </ul>
          </section>
          {related.length ? (
            <section>
              <h2 className="related-title">Writing on verification</h2>
              <ArticleList articles={related} />
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
