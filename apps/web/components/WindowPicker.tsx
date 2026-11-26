"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

// The stats page's time frames. A row of buttons where there is room; on a
// phone the row collapses into one select, so it never wraps under the chart's
// figures. Both are rendered and CSS shows one (see .window-picker).
export function WindowPicker({
  options,
  active,
}: {
  options: { key: string; href: string }[];
  active: string;
}) {
  const router = useRouter();
  return (
    <div className="window-picker">
      <nav className="chart-windows" aria-label="Time window">
        {options.map((o) => (
          <Link
            key={o.key}
            href={o.href}
            className={`chart-win-btn${o.key === active ? " active" : ""}`}
            aria-current={o.key === active ? "page" : undefined}
            scroll={false}
          >
            {o.key}
          </Link>
        ))}
      </nav>
      <select
        className="window-select"
        aria-label="Time window"
        value={active}
        onChange={(e) => {
          const next = options.find((o) => o.key === e.target.value);
          if (next) router.push(next.href, { scroll: false });
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.key === "all" ? "all time" : `last ${o.key}`}
          </option>
        ))}
      </select>
    </div>
  );
}
