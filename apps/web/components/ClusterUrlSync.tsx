"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Makes a dossier's URL carry its cluster, so the one ClusterBanner in the root
 * layout can read it off ?network=. This used to be a server redirect, but
 * reading searchParams on the server made every /p/ render dynamic and
 * uncacheable. The page is cached now, so the correction happens here instead:
 * a history replace, which useSearchParams follows without a refetch.
 */
export function ClusterUrlSync({ network }: { network: "mainnet" | "devnet" }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const param = search.get("network");

  useEffect(() => {
    const wrong =
      (network === "devnet" && param !== "devnet") ||
      (network === "mainnet" && param === "devnet");
    if (!wrong) return;
    const next = new URLSearchParams(search.toString());
    next.set("network", network);
    window.history.replaceState(null, "", `${pathname}?${next.toString()}${window.location.hash}`);
  }, [network, param, pathname, search]);

  return null;
}
