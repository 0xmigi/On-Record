"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pageFont, textWidth } from "@/lib/measure-text";

// One bar split into parts, each part named on the bar itself: a part wide
// enough carries its name and share inside; a narrower one hangs its name
// below the bar on a short arm. No separate key to match colours against.
// Hovering a part shows its count at once; clicking picks it.
//
// With `devParts` (all networks) a second bar, devnet's, sits hatched under
// mainnet's, a shaded band joining each kind's part on one to its part on the
// other. Names go inside mainnet's bar where they fit; the rest hang on arms
// under devnet's.

export type BarPart = {
  key: string;
  label: string;
  value: number;
  /** tone class for the fill, e.g. "tone-s3" */
  tone: string;
};

type Net = "mainnet" | "devnet";

const GAP = 2; // px between parts
const PAD = 12; // label padding inside a part
const LABEL_GAP = 14; // min px between labels below the bar
const ROW_H = 20; // one row of labels below
const BELOW_TOP = 4; // room between the bar and the first row
const ARM = 10; // the arm's run before the name
const ARM_GAP = 5; // between the arm's end and the name
const BAR_H = 40; // one bar alone
const PAIR_H = 26; // each bar of a pair

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

const fmt = (x: number) => (x < 10 || x > 90 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
const num = (n: number) => n.toLocaleString("en-US");

type Geo = { key: string; x: number; w: number };
type Placed = { key: string; w: number; row: number; tick: number; flip: boolean; from: number; to: number };

function layout(parts: BarPart[], width: number | null): { shown: BarPart[]; total: number; geo: Geo[] } {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((a, p) => a + p.value, 0);
  const usable = width != null ? width - GAP * (shown.length - 1) : 0;
  let acc = 0;
  const geo = shown.map((p, i) => {
    const w = total ? (p.value / total) * usable : 0;
    const g = { key: p.key, x: acc + GAP * i, w };
    acc += w;
    return g;
  });
  return { shown, total, geo };
}

export function LabeledBar({
  parts,
  devParts = null,
  pick,
  onPick,
  ariaLabel,
  unit = "programs",
}: {
  parts: BarPart[];
  devParts?: BarPart[] | null;
  pick: string | null;
  onPick: (key: string) => void;
  ariaLabel: string;
  unit?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [fonts, setFonts] = useState<{ name: string; share: string } | null>(null);
  const [hover, setHover] = useState<{ key: string; net: Net } | null>(null);

  useIsoLayout(() => {
    const el = wrapRef.current;
    if (!el) return;
    setFonts({ name: pageFont(el, "--font-sans", "600 13px"), share: pageFont(el, "--font-mono", "12px") });
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const main = layout(parts, width);
  const dev = devParts ? layout(devParts, width) : null;
  if (main.total === 0 && (!dev || dev.total === 0)) return null;
  const paired = dev != null;
  const barH = paired ? PAIR_H : BAR_H;
  const barsH0 = paired ? PAIR_H * 2 : BAR_H;
  const shareIn = (m: { total: number }, p: BarPart) => (m.total ? (p.value / m.total) * 100 : 0);

  // which parts carry their label inside (mainnet's bar); before measuring,
  // guess by share. Paired, the names stand alone; the hover has the numbers.
  const nameW = (p: BarPart) => (fonts ? textWidth(p.label, fonts.name) : 0);
  const labelW = (p: BarPart) =>
    paired ? nameW(p) : fonts ? nameW(p) + 6 + textWidth(`${fmt(shareIn(main, p))}%`, fonts.share) : 0;
  const insideW = (p: BarPart) =>
    fonts ? nameW(p) + 6 + textWidth(`${fmt(shareIn(main, p))}%`, fonts.share) : 0;
  const inside = new Set(
    main.shown
      .filter((p, i) => (width == null || !fonts ? shareIn(main, p) >= 14 : main.geo[i]!.w >= insideW(p) + PAD * 2))
      .map((p) => p.key),
  );
  // Paired, where a kind sits on devnet's bar: its part, or, when devnet has
  // none of it, the gap where it would be, so its band narrows to a point
  const devAt = (key: string): { x: number; w: number } => {
    const dg = dev?.geo.find((d) => d.key === key);
    if (dg) return dg;
    let x = 0;
    for (const p of parts) {
      if (p.key === key) break;
      const g = dev?.geo.find((d) => d.key === p.key);
      if (g) x = g.x + g.w + GAP / 2;
    }
    return { x, w: 0 };
  };
  const mainAt = (key: string): { x: number; w: number } => {
    const g = main.geo.find((d) => d.key === key);
    if (g) return g;
    let x = 0;
    for (const p of parts) {
      if (p.key === key) break;
      const m = main.geo.find((d) => d.key === p.key);
      if (m) x = m.x + m.w + GAP / 2;
    }
    return { x, w: 0 };
  };
  // paired, each bar shows a part's share inside where it fits
  const shareFits = (m: { total: number }, p: BarPart, g: Geo) =>
    width != null && fonts ? g.w >= textWidth(`${fmt(shareIn(m, p))}%`, fonts.share) + PAD * 2 : false;

  // The rest hang below on arms: a line drops from the part, turns and runs a
  // short way to the name, so the name has room of its own. Placed right to
  // left; one that would run into a name already placed, or across another's
  // line, hangs a row lower, so the leftmost hang deepest and no line ever
  // crosses a name.
  const placed: Placed[] = [];
  if (width != null && fonts) {
    const items = main.shown
      .map((p, i) => ({ p, g: paired ? devAt(p.key) : main.geo[i]! }))
      .filter(({ p }) => !inside.has(p.key))
      .reverse();
    for (const { p, g } of items) {
      // paired, the arm hangs from the kind's part on devnet's bar (or the
      // gap its band narrows to), the band above leading back to mainnet's
      const tick = g.x + Math.min(3, g.w / 2);
      const w = labelW(p);
      const reach = ARM + ARM_GAP + w;
      const flip = tick + reach > width; // near the right edge the arm turns left
      const from = flip ? tick - reach : tick;
      const to = flip ? tick : tick + reach;
      // the lowest row with no clash; a clash no row can fix (this line
      // under a name nearer the bar) is accepted rather than looped on
      const clashAt = (row: number) =>
        placed.some(
          (o) =>
            (o.row === row && from < o.to + LABEL_GAP && o.from < to + LABEL_GAP) ||
            (o.row > row && o.tick >= from - 4 && o.tick <= to + 4) ||
            (o.row < row && tick >= o.from - 4 && tick <= o.to + 4),
        );
      let row = 0;
      while (row <= placed.length && clashAt(row)) row++;
      if (row > placed.length) {
        row = 0;
        while (placed.some((o) => o.row === row && from < o.to + LABEL_GAP && o.from < to + LABEL_GAP)) row++;
      }
      placed.push({ key: p.key, w, row, tick, flip, from, to });
    }
  }
  const rows = placed.length ? Math.max(...placed.map((p) => p.row)) + 1 : 0;
  const belowH = rows ? BELOW_TOP + rows * ROW_H : 0;
  const armY = (row: number) => BELOW_TOP + row * ROW_H + ROW_H / 2;

  // Paired: a band joins each kind's part on mainnet's bar to its part on
  // devnet's, so a kind that grows, shrinks or vanishes between networks reads
  // as one shape. Parts keep their order, so bands never cross.
  const RIB_H = 22;
  const bandH = paired ? RIB_H : 0;
  const ribbons =
    paired && width != null
      ? parts
          .filter((p) => main.geo.some((g) => g.key === p.key) || dev!.geo.some((g) => g.key === p.key))
          .map((p) => {
            const t = mainAt(p.key);
            const b = devAt(p.key);
            const h = RIB_H;
            const d = `M${t.x},0 L${t.x + t.w},0 C${t.x + t.w},${h / 2} ${b.x + b.w},${h / 2} ${b.x + b.w},${h} L${b.x},${h} C${b.x},${h / 2} ${t.x},${h / 2} ${t.x},0 Z`;
            return { key: p.key, tone: p.tone, d };
          })
      : [];

  // The box over the bars: the hovered kind, else the picked one, so a click
  // keeps it open. Paired, it gives both networks at once, whichever bar.
  const boxKey = hover?.key ?? pick;
  const boxPart = boxKey ? parts.find((p) => p.key === boxKey) ?? null : null;
  const lineOf = (m: { shown: BarPart[]; total: number }) => {
    const p = boxKey ? m.shown.find((x) => x.key === boxKey) : undefined;
    const v = p?.value ?? 0;
    return `${fmt(m.total ? (v / m.total) * 100 : 0)}% · ${num(v)} ${unit}`;
  };
  const boxLines: { net: Net | null; text: string }[] = boxPart
    ? paired
      ? [
          { net: "mainnet", text: lineOf(main) },
          { net: "devnet", text: lineOf(dev!) },
        ]
      : [{ net: null, text: lineOf(main) }]
    : [];
  const boxAt = boxKey ? main.geo.find((g) => g.key === boxKey) ?? dev?.geo.find((g) => g.key === boxKey) : undefined;
  const tipW =
    boxPart && fonts
      ? Math.max(
          textWidth(boxPart.label, fonts.name.replace("13px", "11px")),
          ...boxLines.map((l) => textWidth(`${l.net ?? ""} ${l.text}`, fonts.share.replace("12px", "11px")) + (l.net ? 34 : 0)),
        ) + 20
      : 0;
  const tipLeft =
    boxAt && width != null ? Math.min(Math.max(boxAt.x + boxAt.w / 2 - tipW / 2, 0), Math.max(0, width - tipW)) : 0;

  const state = (key: string) => `${pick === key ? " is-on" : ""}${pick && pick !== key ? " is-off" : ""}`;

  const bar = (m: { shown: BarPart[]; total: number; geo: Geo[] }, net: Net) => (
    <div
      className={`life-bar${net === "devnet" && paired ? " lbar-dev" : ""}`}
      role="group"
      aria-label={paired ? `${ariaLabel} (${net})` : ariaLabel}
      style={{ height: barH }}
    >
      {m.shown.map((p, i) => {
        const sh = shareIn(m, p);
        const label =
          net === "mainnet" && inside.has(p.key) ? (
            <>
              <span className="life-seg-label">{p.label}</span>
              <span className="life-seg-share">{fmt(sh)}%</span>
            </>
          ) : paired && shareFits(m, p, m.geo[i]!) ? (
            <>
              <span />
              <span className="life-seg-share">{fmt(sh)}%</span>
            </>
          ) : null;
        return (
          <button
            key={p.key}
            type="button"
            className={`life-seg ${p.tone}${state(p.key)}`}
            style={{ width: `${sh}%` }}
            aria-pressed={pick === p.key}
            aria-label={`${p.label}${paired ? `, ${net}` : ""}: ${fmt(sh)}%, ${num(p.value)} ${unit}`}
            onClick={() => onPick(p.key)}
            onMouseEnter={() => setHover({ key: p.key, net })}
            onFocus={() => setHover({ key: p.key, net })}
            onBlur={() => setHover(null)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="lbar" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      <div className="lbar-bars">
        {bar(main, "mainnet")}
        {paired ? (
          <svg className="lbar-ribbons" width={width ?? 0} height={bandH} aria-hidden="true">
            {ribbons.map((r) => (
              <path key={r.key} d={r.d} className={`lbar-ribbon ${r.tone}${state(r.key)}`} />
            ))}
          </svg>
        ) : null}
        {dev ? bar(dev, "devnet") : null}
      </div>

      {belowH ? (
        <div className="lbar-below" style={{ height: belowH }}>
          <svg className="lbar-leads" width={width ?? 0} height={belowH} aria-hidden="true">
            {placed.map((o) => (
              <path
                key={o.key}
                d={`M${o.tick},0 V${armY(o.row)} H${o.flip ? o.tick - ARM : o.tick + ARM}`}
                className={`lbar-lead${state(o.key)}`}
              />
            ))}
          </svg>
          {placed.map((o) => {
            const p = main.shown.find((s) => s.key === o.key)!;
            return (
              <button
                key={o.key}
                type="button"
                className={`lbar-out${state(o.key)}`}
                style={{
                  left: o.flip ? o.tick - ARM - ARM_GAP - o.w : o.tick + ARM + ARM_GAP,
                  top: armY(o.row) - 9,
                  width: o.w,
                }}
                onClick={() => onPick(o.key)}
                onMouseEnter={() => setHover({ key: o.key, net: "mainnet" })}
                aria-pressed={pick === o.key}
              >
                <span className="lbar-name">{p.label}</span>
                {paired ? null : <span className="lbar-share">{fmt(shareIn(main, p))}%</span>}
              </button>
            );
          })}
        </div>
      ) : null}

      {boxPart && boxAt ? (
        <div
          className={`lbar-tip${paired ? " is-pair" : ""}`}
          style={{ left: tipLeft, bottom: barsH0 + bandH + belowH + 6 }}
        >
          <span className="lbar-tip-name">{boxPart.label}</span>
          {boxLines.map((l) => (
            <span className="lbar-tip-line" key={l.net ?? "one"}>
              {l.net ? (
                <>
                  <span className={`pair-swatch${l.net === "devnet" ? " is-dev" : ""}`} />
                  <span className="lbar-tip-net">{l.net}</span>
                </>
              ) : null}
              {l.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
