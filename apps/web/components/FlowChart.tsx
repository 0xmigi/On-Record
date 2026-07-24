"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Deploys over time — stacked vertical bars: new deploys (accent) under
// upgrades (slate blue). Hourly rows come from the API; we aggregate to a
// readable bar count per window and zero-fill empty buckets so spacing is
// honest. Colors live in globals.css (--chart-deploy / --chart-upgrade) so
// dark mode picks its own validated pair. The svg is drawn at the measured
// container width (no viewBox stretching) so text renders true.
// ---------------------------------------------------------------------------

interface VolumePoint {
  t: number;
  count: number;
  deploys?: number;
  upgrades?: number;
}

interface Series {
  deploys: number;
  upgrades: number;
}
interface Bucket {
  t: number; // bucket start, secs
  deploys: number;
  upgrades: number;
  devnet: Series | null; // null = not comparing clusters
}

const H = 220;
const PAD_L = 34; // y tick gutter
const PAD_B = 18; // x label gutter
const PAD_T = 6;

/** bucket seconds per window: 24h→1h, 48h→2h, 7d→6h, 30d→1d */
function bucketSecs(windowSecs: number): number {
  if (windowSecs <= 86_400) return 3_600;
  if (windowSecs <= 172_800) return 7_200;
  if (windowSecs <= 604_800) return 21_600;
  return 86_400;
}

function niceMax(n: number): number {
  if (n <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= n) return m * pow;
  }
  return 10 * pow;
}

/** rect path with only the top corners rounded (data-end round, baseline square) */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${w - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} z`;
}

/** `devnetVolume` opts the chart into cluster comparison: each bucket draws two
 *  bars — this page's cluster and devnet — so their volumes read side by side.
 *  Omit it (or pass an empty series) and the chart stays single-series. */
export function FlowChart({
  volume,
  devnetVolume,
  networkLabel = "mainnet",
  windowSecs,
}: {
  volume: VolumePoint[];
  devnetVolume?: VolumePoint[];
  networkLabel?: string;
  windowSecs: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(920);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(280, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // rows from an API build predating the split have only {t, count}; in that
  // case render ONE combined series — never claim "0 upgrades" we can't know
  const hasSplit = volume.some((p) => p.deploys != null || p.upgrades != null);

  const comparing = (devnetVolume?.length ?? 0) > 0;

  const buckets = useMemo<Bucket[]>(() => {
    const bs = bucketSecs(windowSecs);
    const nowB = Math.floor(Date.now() / 1000 / bs) * bs;
    const startB = nowB - Math.ceil(windowSecs / bs) * bs + bs;
    const map = new Map<number, Bucket>();
    for (let t = startB; t <= nowB; t += bs)
      map.set(t, { t, deploys: 0, upgrades: 0, devnet: comparing ? { deploys: 0, upgrades: 0 } : null });
    const add = (pts: VolumePoint[], into: (b: Bucket) => Series | Bucket | null) => {
      for (const p of pts) {
        const b = map.get(Math.floor(p.t / bs) * bs);
        if (!b) continue;
        const target = into(b);
        if (!target) continue;
        target.deploys += p.deploys ?? p.count;
        target.upgrades += p.upgrades ?? 0;
      }
    };
    add(volume, (b) => b);
    if (comparing) add(devnetVolume!, (b) => b.devnet);
    return [...map.values()];
  }, [volume, devnetVolume, comparing, windowSecs]);

  const n = buckets.length;
  // one scale across both clusters — a shared axis is the whole point of
  // putting them side by side; separate scales would flatter the smaller one
  const yMax = niceMax(
    Math.max(
      1,
      ...buckets.map((b) => Math.max(b.deploys + b.upgrades, (b.devnet?.deploys ?? 0) + (b.devnet?.upgrades ?? 0))),
    ),
  );
  const plotW = width - PAD_L;
  const plotH = H - PAD_B - PAD_T;
  const slot = plotW / n;
  // comparison mode splits the slot into a tight pair, so the two clusters read
  // as one unit per bucket rather than as twice as many independent bars
  const barW = comparing
    ? Math.min(11, Math.max(2, slot * 0.3))
    : Math.min(24, Math.max(3, slot * 0.62));
  const pairGap = comparing ? Math.max(1, barW * 0.18) : 0;
  const y = (v: number) => plotH * (v / yMax);
  const baseY = PAD_T + plotH;

  const fmtBucket = (t: number): string => {
    const d = new Date(t * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    if (windowSecs <= 604_800) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:00`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const fmtTick = (t: number): string => {
    const d = new Date(t * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    if (windowSecs <= 86_400) return `${hh}:00`;
    if (windowSecs <= 172_800) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:00`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  // aim for ~5 x labels on desktop, fewer when narrow
  const labelEvery = Math.max(1, Math.round(n / Math.max(2, Math.min(5, width / 150))));
  const yTicks = yMax % 2 === 0 ? [0, yMax / 2, yMax] : [0, yMax];
  const hovered = hover != null ? buckets[hover] : null;

  return (
    <div className="flow-chart">
      {hasSplit ? (
        <div className="flow-legend" aria-hidden="true">
          <span className="flow-key">
            <span className="flow-swatch flow-swatch-deploy" /> new deploys
          </span>
          <span className="flow-key">
            <span className="flow-swatch flow-swatch-upgrade" /> upgrades
          </span>
          {/* colour carries deploy-vs-upgrade; the cluster is carried by the
              paired position + weight, so it has to be said in words */}
          {comparing ? (
            <>
              <span className="flow-legend-sep">·</span>
              <span className="flow-key">
                <span className="flow-swatch flow-swatch-deploy" /> {networkLabel}
              </span>
              <span className="flow-key">
                <span className="flow-swatch flow-swatch-deploy-devnet" /> devnet
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flow-plot" ref={wrapRef}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="New deploys and upgrades per bucket over the selected window"
          onMouseLeave={() => setHover(null)}
        >
          {/* devnet is the SAME hue, separated by texture rather than by colour
              or weight: a lighter fill reads as a fourth colour and washes out
              in a screenshot, while a hatch stays legible at any size and in
              either theme. Hue keeps meaning deploy-vs-upgrade throughout. */}
          {comparing ? (
            <defs>
              {(["deploy", "upgrade"] as const).map((k) => (
                <pattern
                  key={k}
                  id={`hatch-${k}`}
                  width="5"
                  height="5"
                  patternTransform="rotate(45)"
                  patternUnits="userSpaceOnUse"
                >
                  <rect width="5" height="5" className={`hatch-bg-${k}`} />
                  <line x1="0" y1="0" x2="0" y2="5" className={`hatch-line-${k}`} strokeWidth="2.4" />
                </pattern>
              ))}
            </defs>
          ) : null}
          {yTicks.map((v) => (
            <g key={v}>
              <line className="flow-grid" x1={PAD_L} x2={width} y1={baseY - y(v)} y2={baseY - y(v)} />
              <text className="flow-tick" x={PAD_L - 6} y={baseY - y(v) + 3} textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {buckets.map((b, i) => {
            const cx = PAD_L + slot * i + slot / 2;
            // single: one bar centred. comparing: this cluster left, devnet right
            const x0 = comparing ? cx - barW - pairGap / 2 : cx - barW / 2;
            const xDev = cx + pairGap / 2;
            const stack = (sx: number, s: Series, suffix: string) => {
              const dH = y(s.deploys);
              const uH = y(s.upgrades);
              const gap = uH > 0 && dH > 0 ? 2 : 0; // surface gap between segments
              return (
                <>
                  {dH > 0 ? (
                    uH > 0 ? (
                      <rect className={`flow-bar-deploy${suffix}`} x={sx} y={baseY - dH} width={barW} height={dH} />
                    ) : (
                      <path className={`flow-bar-deploy${suffix}`} d={topRoundedRect(sx, baseY - dH, barW, dH, 3)} />
                    )
                  ) : null}
                  {uH > 0 ? (
                    <path
                      className={`flow-bar-upgrade${suffix}`}
                      d={topRoundedRect(sx, baseY - dH - gap - uH, barW, uH, 3)}
                    />
                  ) : null}
                </>
              );
            };
            return (
              <g key={b.t}>
                {stack(x0, b, "")}
                {comparing && b.devnet ? stack(xDev, b.devnet, "-devnet") : null}
                {hover === i ? (
                  <line className="flow-hover-line" x1={cx} x2={cx} y1={PAD_T} y2={baseY} />
                ) : null}
                <rect
                  className="flow-hit"
                  x={PAD_L + slot * i}
                  y={PAD_T}
                  width={slot}
                  height={plotH}
                  onMouseEnter={() => setHover(i)}
                />
                {i % labelEvery === 0 && i < n - 1 ? (
                  <text className="flow-tick" x={cx} y={H - 4} textAnchor="middle">
                    {fmtTick(b.t)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {hovered ? (
          <div
            className="flow-tip"
            style={{
              left: PAD_L + slot * hover! + slot / 2,
              transform: hover! > n * 0.7 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            }}
          >
            <span className="flow-tip-time">{fmtBucket(hovered.t)}</span>
            {hasSplit ? (
              <>
                {comparing ? <span className="flow-tip-net">{networkLabel}</span> : null}
                <span className="flow-tip-row">
                  <span className="flow-swatch flow-swatch-deploy" />
                  {hovered.deploys} new
                </span>
                <span className="flow-tip-row">
                  <span className="flow-swatch flow-swatch-upgrade" />
                  {hovered.upgrades} upgrades
                </span>
                {comparing && hovered.devnet ? (
                  <>
                    <span className="flow-tip-net">devnet</span>
                    <span className="flow-tip-row">
                      <span className="flow-swatch flow-swatch-deploy-devnet" />
                      {hovered.devnet.deploys} new
                    </span>
                    <span className="flow-tip-row">
                      <span className="flow-swatch flow-swatch-upgrade-devnet" />
                      {hovered.devnet.upgrades} upgrades
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <span className="flow-tip-row">
                <span className="flow-swatch flow-swatch-deploy" />
                {hovered.deploys + hovered.upgrades} deploys + upgrades
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
