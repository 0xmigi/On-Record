import Link from "next/link";
import { Mark } from "@/components/Mark";

/**
 * Site footer: the wordmark and the motto on the left, short columns of links
 * on the right, the Helius credit underneath. The quieter pages (method,
 * writing, the radar's verification views) live here rather than in the top
 * bar, which stays for the few things people use every visit.
 */

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Explore",
    links: [
      { label: "Radar", href: "/" },
      { label: "Stats", href: "/funnel" },
      { label: "Saved", href: "/saved" },
    ],
  },
  {
    title: "Verify",
    links: [
      { label: "Alerts", href: "/verification" },
      { label: "Lost verification", href: "/?type=upgrade&window=all&verified=lost" },
      { label: "Verified programs", href: "/?type=upgrade&window=all&verified=1" },
    ],
  },
  {
    title: "Learn",
    links: [
      { label: "Methodology", href: "/methodology" },
      { label: "Writing", href: "/writing" },
    ],
  },
  {
    title: "More",
    links: [
      { label: "X", href: "https://x.com/0xmigi", external: true },
      { label: "GitHub", href: "https://github.com/0xmigi/On-Record", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link className="wordmark" href="/">
            <Mark size={18} />
            <span>on record</span>
          </Link>
          <p className="footer-motto">Every deploy and upgrade on Solana mainnet.</p>
        </div>
        <nav className="footer-cols" aria-label="Footer">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="footer-col-title">{col.title}</div>
              <ul>
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.external ? (
                      <a href={l.href} target="_blank" rel="noopener noreferrer">
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href}>{l.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="footer-base">
        <div className="footer-base-rule">
          <a className="footer-credit" href="https://www.helius.dev" target="_blank" rel="noopener noreferrer">
            Powered by
            {/* the real mark + wordmark from the Helius brand kit, not ours */}
            <img className="footer-helius" src="/brand/helius-horizontal.svg" alt="Helius" width={72} height={15} />
          </a>
        </div>
      </div>
    </footer>
  );
}
