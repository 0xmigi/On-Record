import type { Metadata } from "next";
import { Suspense } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { ClusterBanner } from "@/components/ClusterBanner";
import { Mark } from "@/components/Mark";
import { NetworkToggle } from "@/components/NetworkToggle";
import { SearchBox } from "@/components/SearchBox";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://on-record.azuolas.xyz"),
  title: {
    default: "On Record — the novel-program radar for Solana",
    template: "%s — On Record",
  },
  description:
    "On Record watches every program deployed or upgraded on Solana mainnet, strips out the copy-paste clones, and ranks what's left by a novelty score.",
  // og:site_name — Discord/Slack show this above the title; without it the card reads anonymous
  openGraph: { siteName: "On Record", type: "website" },
  // X defaults to the small "summary" tile, which showed a placeholder icon
  // instead of the card. Set here so every route inherits it, not just dossiers.
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to the radar
        </a>

        <header className="topbar">
          <div className="topbar-inner">
            <Link className="wordmark" href="/">
              <Mark size={20} />
              <span>on record</span>
            </Link>
            <SearchBox />
            <nav className="topnav" aria-label="Main">
              {/* one copy of the links: inline on desktop, and below 720px the
                  summary becomes a hamburger and the panel drops down. Pure
                  <details>, so the layout stays a server component. */}
              <details className="navmenu">
                <summary className="navmenu-btn" aria-label="Menu">
                  <span className="navmenu-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </summary>
                <div className="navmenu-panel">
                  <Link href="/">Radar</Link>
                  <Link href="/funnel">Stats</Link>
                  <Link href="/methodology">Method</Link>
                  <Link href="/saved">Saved</Link>
                  <p className="navmenu-motto">Strip the copy-paste. Rank what&apos;s new.</p>
                </div>
              </details>
              {/* useSearchParams needs a Suspense boundary in a layout */}
              <Suspense fallback={null}>
                <NetworkToggle />
              </Suspense>
            </nav>
          </div>
        </header>

        {/* dims the page while the nav sheet is open; a sibling of the bar so it
            sits behind it, driven by :has() rather than client state */}
        <div className="navmenu-scrim" aria-hidden="true" />

        <Suspense fallback={null}>
          <ClusterBanner />
        </Suspense>

        <main className="page" id="main">
          {children}
        </main>

        <footer className="footer">
          <p className="footer-motto">
            Strip the copy-paste. Rank what&apos;s new.
          </p>
          <a
            className="footer-credit"
            href="https://www.helius.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            Powered by
            {/* the real mark + wordmark from the Helius brand kit, not ours */}
            <img
              className="footer-helius"
              src="/brand/helius-horizontal.svg"
              alt="Helius"
              width={72}
              height={15}
            />
          </a>
        </footer>

        <Analytics />
      </body>
    </html>
  );
}
