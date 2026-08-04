"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Radar" },
  { href: "/funnel", label: "Stats" },
  { href: "/methodology", label: "Method" },
  { href: "/saved", label: "Saved" },
] as const;

/**
 * The main nav. Inline links on desktop; below 720px the button becomes a
 * hamburger and the panel drops as a full-width sheet — see .navmenu in
 * globals.css, which decides which of the two you get.
 *
 * Plain React state rather than <details>: the sheet has to close on
 * navigation (App Router keeps the layout mounted, so it used to stay open on
 * top of the page you'd just moved to and read as a dead link), and the scrim
 * lives outside the header so it can paint under the bar. Both need the open
 * state in a place CSS can reach reliably, which `open`/`:has()` was not.
 */
export function NavMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close on navigation
  useEffect(() => setOpen(false), [pathname]);

  // publish to <body> so the scrim, which is not a descendant, can respond
  useEffect(() => {
    document.body.classList.toggle("nav-open", open);
    return () => document.body.classList.remove("nav-open");
  }, [open]);

  // click-outside and Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false);
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

  return (
    <div className={`navmenu${open ? " open" : ""}`} ref={ref}>
      <button
        type="button"
        className="navmenu-btn"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="navmenu-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>
      <div className="navmenu-panel">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={pathname === l.href ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            {l.label}
          </Link>
        ))}
        <p className="navmenu-motto">Strip the copy-paste. Rank what&apos;s new.</p>
      </div>
    </div>
  );
}
