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
            {/* reads ?network= to scope results — needs its own boundary */}
            <Suspense fallback={<div className="search-wrap" />}>
              <SearchBox />
            </Suspense>
            <nav className="topnav" aria-label="Main">
              <Link href="/">Radar</Link>
              <Link href="/funnel">Stats</Link>
              <Link href="/saved">Saved</Link>
              {/* useSearchParams needs a Suspense boundary in a layout */}
              <Suspense fallback={null}>
                <NetworkToggle />
              </Suspense>
            </nav>
          </div>
        </header>

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
            Powered by <Mark size={13} />{" "}
            <span className="footer-helius">HELIUS</span>
          </a>
        </footer>

        <Analytics />
      </body>
    </html>
  );
}
