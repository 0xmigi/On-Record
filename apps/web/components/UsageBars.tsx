import type { InstructionUsage } from "@/lib/api";

/** The program's real "shape": which instructions actually get called, decoded
 *  from recent transactions by discriminator. Deterministic — names are the
 *  developer's, sizes are on-chain counts. `compact` shows just the top few. */
export function UsageBars({
  usage,
  compact = false,
  top = 3,
}: {
  usage: InstructionUsage;
  compact?: boolean;
  top?: number;
}) {
  if (!usage.instructions.length) return null;
  const list = compact ? usage.instructions.slice(0, top) : usage.instructions;
  const maxCount = usage.instructions[0]?.count || 1;
  const w = usage.window;
  const extra = usage.instructions.length - list.length;

  return (
    <div className={`usage${compact ? " usage-compact" : ""}`}>
      <div className="usage-head">
        <span className="usage-title">How it&apos;s used</span>
        <span className="usage-sub">
          last {w.txnsWithProgram.toLocaleString("en-US")} txns
          {w.hoursSpan != null ? ` · ${w.hoursSpan >= 1 ? `~${w.hoursSpan}h` : "<1h"}` : ""}
        </span>
      </div>
      <div className="usage-bars">
        {list.map((i) => (
          <div className="usage-row" key={i.name}>
            <span className="usage-name" title={i.name}>
              {i.name}
            </span>
            <div className="usage-track">
              <div
                className="usage-bar"
                style={{ width: `${Math.max(2, (i.count / maxCount) * 100)}%` }}
              />
            </div>
            <span className="usage-pct">{i.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
      <p className="usage-foot">
        {usage.instructions.length} of {usage.totalInstructions} instructions used
        {usage.unusedCount ? ` · ${usage.unusedCount} never called in this window` : ""}
        {compact && extra > 0 ? ` · +${extra} more` : ""}
      </p>
    </div>
  );
}
