"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pageFont, textWidth } from "@/lib/measure-text";

// Each framework's share of the window's programs over time: a 100% stacked
// area, the biggest framework at the bottom, bands in greys split by a
// hairline. Each band carries its own name, placed where the band is thick
// enough to hold it; a band too thin anywhere is named at the right edge with
// a short line to it. Hovering shows every share for that bucket and lights
// the band under the cursor; clicking a band picks that framework.

const H = 200;
const PAD_L = 0;
const PAD_T_PLAIN = 6;
const PAD_T_SEAM = 20; // room above the plot for the seam labels
const PAD_B = 0;
const TEXT_H = 15; // a band must be this tall to hold its name
const LABEL_PAD = 8;

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** frameworks whose fill is dark enough to want light text */
const DARK_FILL = new Set(["anchor", "native"]);

type Label = { f: string; x: number; y: number; outside?: { fromY: number } };

export function FrameworkShareChart({
  points,
  order: orderIn,
  bucketSecs,
  highlight = null,
  onPick,
  archiveUntil = null,
  archiveLabel = "archive",
}: {
  points: { t: number; counts: Record<string, number> }[];
  /** frameworks bottom to top */
  order: string[];
  bucketSecs: number;
  /** a framework picked elsewhere: lit unless hovering */
  highlight?: string | null;
  onPick?: (framework: string) => void;
  /** buckets before this (unix s) come from the archive: marked with a line */
  archiveUntil?: number | null;
  archiveLabel?: string;
}) {
  const [hoverLit, setLit] = useState<string | null>(null);
  const lit = hoverLit ?? highlight;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [font, setFont] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useIsoLayout(() => {
    const el = wrapRef.current;
    if (!el) return;
    setFont(pageFont(el, "--font-sans", "500 12px"));
    setWidth(Math.max(280, el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(280, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the given order, then any framework only the series has (the archive's
  // "c-style", from before Pinocchio existed), on top
  const order = useMemo(() => {
    const extra = new Set<string>();
    for (const p of points) for (const k of Object.keys(p.counts)) if (!orderIn.includes(k)) extra.add(k);
    return [...orderIn, ...extra];
  }, [points, orderIn]);

  // shares per point, stacked in `order`
  const rows = useMemo(
    () =>
      points
        .map((p) => {
          const total = order.reduce((a, f) => a + (p.counts[f] ?? 0), 0);
          let acc = 0;
          const bands = order.map((f) => {
            const share = total > 0 ? (p.counts[f] ?? 0) / total : 0;
            const band = { f, y0: acc, y1: acc + share, share, n: p.counts[f] ?? 0 };
            acc += share;
            return band;
          });
          return { t: p.t, total, bands };
        })
        .filter((r) => r.total > 0)
        // the bucket still filling (today) would read as a swing; leave it out
        .filter((r) => r.t + bucketSecs <= Date.now() / 1000),
    [points, order, bucketSecs],
  );

  const seamT =
    archiveUntil != null && rows.length >= 2 && archiveUntil > rows[0].t && archiveUntil <= rows[rows.length - 1].t
      ? archiveUntil
      : null;
  const PAD_T = seamT != null ? PAD_T_SEAM : PAD_T_PLAIN;
  const plotH = H - PAD_T - PAD_B;
  const y = (share: number) => PAD_T + plotH * (1 - share);
  const present = order.filter((f, i) => rows.some((r) => r.bands[i].n > 0));

  // geometry for a given right gutter
  const geometry = (padR: number) => {
    const w = width ?? 900;
    const plotW = w - PAD_L - padR;
    const t0 = rows.length ? rows[0].t : 0;
    const t1 = rows.length ? rows[rows.length - 1].t : 1;
    const x = (t: number) => PAD_L + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const xs = rows.map((r) => x(r.t));
    // a band's top and bottom (px) at any x, straight between points
    const at = (bi: number, px: number) => {
      let j = 0;
      while (j < xs.length - 2 && xs[j + 1] < px) j++;
      const a = rows[j].bands[bi];
      const b = rows[Math.min(j + 1, rows.length - 1)].bands[bi];
      const span = Math.max(1e-6, xs[Math.min(j + 1, xs.length - 1)] - xs[j]);
      const k = Math.min(1, Math.max(0, (px - xs[j]) / span));
      return { top: y(a.y1 + (b.y1 - a.y1) * k), bottom: y(a.y0 + (b.y0 - a.y0) * k) };
    };
    return { plotW, x, xs, at };
  };

  // find room inside each band for its name; the rest go to a right gutter
  const layout = (padR: number) => {
    const g = geometry(padR);
    const inside: Label[] = [];
    const missed: string[] = [];
    for (const f of present) {
      const bi = order.indexOf(f);
      const w = (font ? textWidth(f, font) : f.length * 7) + LABEL_PAD * 2;
      // try the thickest points first
      const cand = g.xs
        .map((px, i) => ({ px, h: y(rows[i].bands[bi].y0) - y(rows[i].bands[bi].y1) }))
        .filter((c) => c.h >= TEXT_H)
        .sort((a, b) => b.h - a.h);
      let found: Label | null = null;
      for (const c of cand) {
        const left = Math.min(Math.max(c.px - w / 2, PAD_L), PAD_L + g.plotW - w);
        const right = left + w;
        const samples = [left, right, ...g.xs.filter((px) => px > left && px < right)];
        let maxTop = -Infinity;
        let minBottom = Infinity;
        for (const s of samples) {
          const b = g.at(bi, s);
          maxTop = Math.max(maxTop, b.top);
          minBottom = Math.min(minBottom, b.bottom);
        }
        if (minBottom - maxTop >= TEXT_H) {
          found = { f, x: left + w / 2, y: (maxTop + minBottom) / 2 };
          break;
        }
      }
      if (found) inside.push(found);
      else missed.push(f);
    }
    return { g, inside, missed };
  };

  const first = rows.length >= 2 ? layout(8) : null;
  const gutter =
    first && first.missed.length
      ? 22 + Math.max(...first.missed.map((f) => (font ? textWidth(f, font) : f.length * 7)))
      : 8;
  const final = first && first.missed.length ? layout(gutter) : first;

  if (!final || rows.length < 2) {
    return <div className="fw-share" ref={wrapRef} />;
  }
  const { g } = final;
  const w = width ?? 900;
  const plotRight = PAD_L + g.plotW;

  // names at the right edge for bands too thin to hold one, spaced apart
  const outside: Label[] = final.missed
    .map((f) => {
      const b = g.at(order.indexOf(f), plotRight);
      const mid = (b.top + b.bottom) / 2;
      return { f, x: plotRight + 14, y: mid, outside: { fromY: mid } };
    })
    .sort((a, b) => a.y - b.y);
  for (let i = 0; i < outside.length; i++) {
    outside[i].y = Math.max(outside[i].y, PAD_T + 6, i ? outside[i - 1].y + 14 : -Infinity);
  }
  for (let i = outside.length - 1; i >= 0; i--) {
    outside[i].y = Math.min(outside[i].y, H - 6, i < outside.length - 1 ? outside[i + 1].y - 14 : Infinity);
  }

  const paths = order.map((f, i) => {
    const top = rows.map((r, j) => `${g.xs[j]},${y(r.bands[i].y1)}`);
    const bottom = rows.map((r, j) => `${g.xs[j]},${y(r.bands[i].y0)}`).reverse();
    return { f, d: `M${top.join(" L")} L${bottom.join(" L")} Z` };
  });

  const fmt = (t: number) => {
    const d = new Date(t * 1000);
    // weekly buckets span years, so they carry one ("week of Jul 9, 2026")
    return bucketSecs >= 604_800
      ? `week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
      : bucketSecs >= 86_400
      ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
      : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
  };
  const hovered = hover != null ? rows[hover] : null;
  const slug = (f: string) => f.replace(/\s+/g, "-");
  const faded = (f: string) => (lit && lit !== f ? " is-faded" : "");

  // which bucket and band sit under the pointer
  const under = (e: React.MouseEvent<SVGSVGElement>): { i: number | null; band: string | null } => {
    const named = (e.target as Element).closest?.("[data-fw]")?.getAttribute("data-fw");
    if (named) return { i: null, band: named };
    const r = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (mx > plotRight) return { i: null, band: null };
    let i = 0;
    for (let j = 1; j < g.xs.length; j++) if (Math.abs(g.xs[j] - mx) < Math.abs(g.xs[i] - mx)) i = j;
    const band = present.find((f) => {
      const b = g.at(order.indexOf(f), mx);
      return my >= b.top && my <= b.bottom;
    });
    return { i, band: band ?? null };
  };
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const u = under(e);
    setHover(u.i);
    setLit(u.band);
  };

  return (
    <div className="fw-share" ref={wrapRef}>
      <svg
        width={w}
        height={H}
        role="img"
        aria-label="Each framework's share of programs over the window"
        className={onPick ? "is-pickable" : undefined}
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          setLit(null);
        }}
        onClick={(e) => {
          const band = under(e).band;
          if (onPick && band) onPick(band);
        }}
      >
        {paths.map((p) => (
          <path key={p.f} className={`fw-area fw-${slug(p.f)}${faded(p.f)}`} d={p.d} />
        ))}

        {seamT != null ? (
          <g className="fw-seam">
            <line className="flow-record-line" x1={g.x(seamT)} x2={g.x(seamT)} y1={4} y2={PAD_T + plotH} />
            {g.x(seamT) - PAD_L > 70 ? (
              <text className="flow-record-label" x={PAD_L} y={11}>
                {archiveLabel}
              </text>
            ) : null}
            <text
              className="flow-record-label"
              x={g.x(seamT) + (plotRight - g.x(seamT) < 90 ? -6 : 6)}
              y={11}
              textAnchor={plotRight - g.x(seamT) < 90 ? "end" : "start"}
            >
              record starts
            </text>
          </g>
        ) : null}

        {hovered ? (
          <line
            className="flow-hover-line"
            x1={g.xs[hover!]}
            x2={g.xs[hover!]}
            y1={PAD_T}
            y2={PAD_T + plotH}
          />
        ) : null}

        {final.inside.map((l) => (
          <text
            key={l.f}
            className={`fw-band-label${DARK_FILL.has(l.f) ? " is-light" : ""}${faded(l.f)}${highlight === l.f ? " is-on" : ""}`}
            x={l.x}
            y={l.y}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {l.f}
          </text>
        ))}
        {outside.map((l) => (
          <g key={l.f} data-fw={l.f} className={`fw-out${faded(l.f)}`}>
            <path
              className="fw-out-lead"
              d={`M${plotRight + 1},${l.outside!.fromY} L${plotRight + 6},${l.outside!.fromY} L${plotRight + 10},${l.y}`}
            />
            <text
              className={`fw-band-label is-out${highlight === l.f ? " is-on" : ""}`}
              x={l.x}
              y={l.y}
              dominantBaseline="central"
            >
              {l.f}
            </text>
          </g>
        ))}
      </svg>
      {hovered ? (
        <div
          className="flow-tip"
          style={{
            left: g.xs[hover!],
            transform: hover! > rows.length * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <span className="flow-tip-time">{fmt(hovered.t)}</span>
          {[...hovered.bands].reverse().map((b) =>
            b.n > 0 ? (
              <span className={`flow-tip-row${lit === b.f ? " is-lit" : ""}`} key={b.f}>
                <span className={`flow-swatch fw-${slug(b.f)}`} />
                {b.f} {Math.round(b.share * 100)}% · {b.n}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}
