"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * App-wide devnet indicator (Orb-style): a full-width strip under the topbar.
 *
 * The rule that matters: **what you are looking at wins over how you are
 * browsing.** Originally this only read the browsing mode (?network= then the
 * cookie), so opening a devnet program from the Saved list while in mainnet
 * mode showed no devnet indication anywhere on the page — a devnet dossier
 * rendered identically to a mainnet one. That is the worst possible failure
 * for this component, because the whole point is that the cluster is never
 * ambiguous.
 *
 * So a page that knows its subject's cluster passes `network` and that is
 * authoritative. The layout-level instance takes no prop and falls back to
 * browsing mode, but stands down on routes that declare their own (`/p/…`)
 * rather than racing them.
 */
export function ClusterBanner({ network }: { network?: "mainnet" | "devnet" }) {
  const search = useSearchParams();
  const pathname = usePathname();
  const [cookieNet, setCookieNet] = useState<"mainnet" | "devnet" | null>(null);

  // re-read the persisted cluster on every navigation (the toggle may have
  // just changed it); document.cookie is client-only, hence the effect.
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)network=(devnet|mainnet)/);
    setCookieNet(m ? (m[1] as "mainnet" | "devnet") : null);
  }, [search]);

  // Subject-driven: the page told us, and it read this off the program itself.
  if (network) return network === "devnet" ? <Banner subjectDriven /> : null;

  // Mode-driven fallback. Dossier routes render their own instance from the
  // program's real network, so defer to them instead of showing a second
  // strip (or worse, contradicting it).
  if (pathname?.startsWith("/p/")) return null;

  const param = search.get("network");
  const current: "mainnet" | "devnet" =
    param === "devnet" ? "devnet" : param === "mainnet" ? "mainnet" : cookieNet ?? "mainnet";
  if (current !== "devnet") return null;
  return <Banner />;
}

function Banner({ subjectDriven = false }: { subjectDriven?: boolean }) {
  return (
    <div className="cluster-banner" role="status">
      <span>
        {subjectDriven ? (
          <>
            This program is on <strong>devnet</strong>
          </>
        ) : (
          <>
            You&apos;re viewing <strong>devnet</strong>
          </>
        )}
      </span>
      <Link
        href="/?network=mainnet"
        className="cluster-banner-switch"
        onClick={() => {
          document.cookie = "network=mainnet; path=/; max-age=31536000; samesite=lax";
        }}
      >
        view mainnet →
      </Link>
    </div>
  );
}
