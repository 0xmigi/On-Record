"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Gear menu in the top nav (Orb-style): a settings dropdown with a NETWORK
 *  section — Mainnet / Devnet, checkmark on the active cluster. */
export function NetworkToggle() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const onRadar = pathname === "/";
  const isDevnet = onRadar && search.get("network") === "devnet";

  const href = (net: "mainnet" | "devnet"): string => {
    const params = new URLSearchParams(onRadar ? search : undefined);
    params.delete("network");
    if (net === "devnet") params.set("network", "devnet");
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Item = ({ net, label }: { net: "mainnet" | "devnet"; label: string }) => {
    const active = net === "devnet" ? isDevnet : !isDevnet;
    return (
      <Link className="net-menu-item" href={href(net)} onClick={() => setOpen(false)}>
        <span>{label}</span>
        {active ? (
          <span className="net-menu-check" aria-hidden="true">
            ✓
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="net-menu" ref={rootRef}>
      <button
        type="button"
        className="net-menu-btn"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open ? (
        <div className="net-menu-panel" role="menu" aria-label="Settings">
          <div className="net-menu-head">Network</div>
          <Item net="mainnet" label="Mainnet" />
          <Item net="devnet" label="Devnet" />
        </div>
      ) : null}
    </div>
  );
}
