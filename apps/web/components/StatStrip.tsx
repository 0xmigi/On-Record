import type { ApiStats } from "@/lib/api";

/**
 * Thin strip of today's numbers. Mono digits, near-black.
 * When the API is unreachable each figure shows an em dash —
 * the record never pretends to know a number it doesn't.
 */
export function StatStrip({ stats }: { stats: ApiStats | null }) {
  const cells: { value: string; label: string }[] = [
    {
      value: stats ? String(stats.launchesToday) : "—",
      label: "launched today",
    },
    {
      value: stats ? String(stats.updatesToday) : "—",
      label: "updates today",
    },
    {
      value: stats ? `${stats.copyPercentToday}%` : "—",
      label: "copies today",
    },
    {
      value: stats ? String(stats.radarThisWeek) : "—",
      label: "on the radar this week",
    },
  ];

  return (
    <div className="stat-strip" role="group" aria-label="Today on the record">
      {cells.map((cell) => (
        <div className="stat" key={cell.label}>
          <span className="stat-num">{cell.value}</span>
          <span className="stat-label">{cell.label}</span>
        </div>
      ))}
    </div>
  );
}
