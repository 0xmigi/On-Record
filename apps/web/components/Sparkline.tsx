// Dependency-free, server-rendered activity sparkline: hourly tx-count
// buckets as a filled step-ish line. Decoded counts only — no smoothing that
// would invent a shape the data doesn't have.

export interface SparkPoint {
  t: number; // hour bucket, epoch ms
  c: number; // tx count
}

export function Sparkline({
  points,
  width = 220,
  height = 36,
  title,
  max: maxOverride,
  baseline = false,
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
  title?: string;
  /** Scale the Y axis to THIS instead of the series' own peak. Several sparks
   *  drawn side by side are only comparable on one shared scale — normalised
   *  individually, a program doing 6 transactions and one doing 7,783 draw the
   *  same height, which is the exact comparison a row of sparks exists to make. */
  max?: number;
  /** Draw a hairline at zero. Only worth it on a shared scale, where a quiet
   *  series is a flat line near the floor and needs a floor to be near. */
  baseline?: boolean;
}) {
  if (points.length < 2) return null;
  const PAD = 2;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(1, maxOverride ?? Math.max(...points.map((p) => p.c)));
  const x = (t: number) => PAD + ((t - t0) / span) * (width - 2 * PAD);
  const y = (c: number) => height - PAD - (c / max) * (height - 2 * PAD);
  const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(" ");
  const area = `${PAD},${height - PAD} ${line} ${(width - PAD).toFixed(1)},${height - PAD}`;
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title ?? "activity over time"}
    >
      {title ? <title>{title}</title> : null}
      {baseline ? (
        <line
          x1={PAD}
          y1={height - PAD}
          x2={width - PAD}
          y2={height - PAD}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.18}
        />
      ) : null}
      <polygon points={area} fill="currentColor" opacity={0.12} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
