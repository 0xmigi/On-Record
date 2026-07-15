"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** App-wide devnet indicator (Orb-style). Shows a full-width strip under the
 *  topbar whenever the selected cluster is devnet — the radar's ?network= wins,
 *  else the persisted cookie set by the toggle. Stays visible on every page
 *  (radar, dossier, stats) so the cluster is never ambiguous. */
export function ClusterBanner() {
  const search = useSearchParams();
  const [cookieNet, setCookieNet] = useState<"mainnet" | "devnet" | null>(null);

  // re-read the persisted cluster on every navigation (the toggle may have
  // just changed it); document.cookie is client-only, hence the effect.
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)network=(devnet|mainnet)/);
    setCookieNet(m ? (m[1] as "mainnet" | "devnet") : null);
  }, [search]);

  const param = search.get("network");
  const current: "mainnet" | "devnet" =
    param === "devnet" ? "devnet" : param === "mainnet" ? "mainnet" : cookieNet ?? "mainnet";

  if (current !== "devnet") return null;

  return (
    <div className="cluster-banner" role="status">
      <span>
        You&apos;re viewing <strong>devnet</strong>
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
