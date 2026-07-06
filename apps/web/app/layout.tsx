import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { RSS_URL } from "@/lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "On Record — announcements are claims, deployments are facts",
    template: "%s — On Record",
  },
  description:
    "An agentic newsroom for Solana. It watches what actually ships on chain and puts it on the record.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to stories
        </a>

        <header className="topbar">
          <div className="topbar-inner">
            <Link className="wordmark" href="/">
              <Mark size={20} />
              <span>on record</span>
            </Link>
            <form className="search-form" action="/" role="search">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                className="search-input"
                type="search"
                name="q"
                placeholder="Search a project, key, or story…"
                aria-label="Search the record"
              />
            </form>
            <nav className="topnav" aria-label="Main">
              <Link href="/">Feed</Link>
              <Link href="/lab">The Lab</Link>
              <a href={RSS_URL} target="_blank" rel="noopener noreferrer">
                RSS
              </a>
            </nav>
          </div>
        </header>

        <main className="page" id="main">
          {children}
        </main>

        <footer className="footer">
          <p className="footer-motto">Announcements are claims. Deployments are facts.</p>
          <a
            className="footer-credit"
            href="https://www.helius.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            Powered by <Mark size={13} /> <span className="footer-helius">HELIUS</span>
          </a>
        </footer>
      </body>
    </html>
  );
}
