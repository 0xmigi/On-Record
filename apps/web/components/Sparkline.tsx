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
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
  title?: string;
}) {
  if (points.length < 2) return null;
  const PAD = 2;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(1, ...points.map((p) => p.c));
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
      <polygon points={area} fill="currentColor" opacity={0.12} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
