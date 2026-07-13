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

interface Bucket {
  t: number; // bucket start, secs
  deploys: number;
  upgrades: number;
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

export function FlowChart({
  volume,
  windowSecs,
}: {
  volume: VolumePoint[];
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

  const buckets = useMemo<Bucket[]>(() => {
    const bs = bucketSecs(windowSecs);
    const nowB = Math.floor(Date.now() / 1000 / bs) * bs;
    const startB = nowB - Math.ceil(windowSecs / bs) * bs + bs;
    const map = new Map<number, Bucket>();
    for (let t = startB; t <= nowB; t += bs) map.set(t, { t, deploys: 0, upgrades: 0 });
    for (const p of volume) {
      const key = Math.floor(p.t / bs) * bs;
      const b = map.get(key);
      if (!b) continue;
      b.deploys += p.deploys ?? p.count;
      b.upgrades += p.upgrades ?? 0;
    }
    return [...map.values()];
  }, [volume, windowSecs]);

  const n = buckets.length;
  const yMax = niceMax(Math.max(1, ...buckets.map((b) => b.deploys + b.upgrades)));
  const plotW = width - PAD_L;
  const plotH = H - PAD_B - PAD_T;
  const slot = plotW / n;
  const barW = Math.min(24, Math.max(3, slot * 0.62));
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
            const x0 = cx - barW / 2;
            const dH = y(b.deploys);
            const uH = y(b.upgrades);
            const gap = uH > 0 && dH > 0 ? 2 : 0; // surface gap between segments
            return (
              <g key={b.t}>
                {dH > 0 ? (
                  uH > 0 ? (
                    <rect className="flow-bar-deploy" x={x0} y={baseY - dH} width={barW} height={dH} />
                  ) : (
                    <path className="flow-bar-deploy" d={topRoundedRect(x0, baseY - dH, barW, dH, 3)} />
                  )
                ) : null}
                {uH > 0 ? (
                  <path
                    className="flow-bar-upgrade"
                    d={topRoundedRect(x0, baseY - dH - gap - uH, barW, uH, 3)}
                  />
                ) : null}
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
                <span className="flow-tip-row">
                  <span className="flow-swatch flow-swatch-deploy" />
                  {hovered.deploys} new
                </span>
                <span className="flow-tip-row">
                  <span className="flow-swatch flow-swatch-upgrade" />
                  {hovered.upgrades} upgrades
                </span>
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
