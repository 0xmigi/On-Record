import type { Signal } from "@/lib/signals";

// Pentagon signal chart (the "skill graph"): one vertex per visible signal,
// server-rendered SVG, no dependencies. Small (card) renders shape only with
// a hover tooltip; large (dossier) adds labels. The shape is a silhouette of
// five explainable numbers — never a composite score.

export function SignalHex({
  signals,
  size = 56,
  labels = false,
}: {
  signals: Signal[];
  size?: number;
  labels?: boolean;
}) {
  const n = signals.length;
  if (n < 3) return null;
  const pad = labels ? 30 : 3;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - pad;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, scale: number) =>
    `${(cx + r * scale * Math.cos(angle(i))).toFixed(1)},${(cy + r * scale * Math.sin(angle(i))).toFixed(1)}`;

  const ring = (scale: number) =>
    signals.map((_, i) => pt(i, scale)).join(" ");
  // floor tiny values so the silhouette always shows all vertices
  const shape = signals.map((s, i) => pt(i, Math.max(0.06, s.value))).join(" ");
  const tooltip = signals.map((s) => `${s.label}: ${s.why}`).join("\n");

  return (
    <svg
      className="signal-hex"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={tooltip}
    >
      <title>{tooltip}</title>
      <polygon points={ring(1)} className="signal-hex-grid" />
      <polygon points={ring(0.5)} className="signal-hex-grid" />
      {signals.map((_, i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={pt(i, 1).split(",")[0]}
          y2={pt(i, 1).split(",")[1]}
          className="signal-hex-spoke"
        />
      ))}
      <polygon points={shape} className="signal-hex-shape" />
      {labels
        ? signals.map((s, i) => {
            const lx = cx + (r + 14) * Math.cos(angle(i));
            const ly = cy + (r + 14) * Math.sin(angle(i));
            return (
              <text
                key={s.key}
                x={lx.toFixed(1)}
                y={ly.toFixed(1)}
                className="signal-hex-label"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {s.label}
              </text>
            );
          })
        : null}
    </svg>
  );
}
