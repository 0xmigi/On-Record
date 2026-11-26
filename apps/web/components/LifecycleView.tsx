"use client";

import { useState } from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { CardFoot, MeterList, type MeterRow } from "@/components/StatBits";

// Lifecycle as one view: the window's new programs split into still live and
// closed, as one bar across the card. Each part is a button: pick one to see
// only its stats, pick it again (or the other) to switch; with neither picked
// both sides show, live on the left, closed on the right.

type Side = "live" | "closed";

export function LifecycleView({
  windowLabel,
  live,
  closed,
  showSplit = true,
  closedWithin,
  medianLife,
  upgradeWithin,
  medianGap,
  upgradeInfo,
  clones,
}: {
  windowLabel: string;
  live: number;
  closed: number;
  /** false where closures are not tracked (devnet): no live/closed split */
  showSplit?: boolean;
  closedWithin: MeterRow[] | null;
  medianLife: { main: string; dev: string | null } | null;
  upgradeWithin: MeterRow[] | null;
  medianGap: { main: string; dev: string | null } | null;
  upgradeInfo: string;
  clones: MeterRow[] | null;
}) {
  const [pick, setPick] = useState<Side | null>(null);
  if (showSplit && live + closed === 0) return null;
  const fmt = (x: number) => (x < 10 || x > 90 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
  const toggle = (s: Side) => setPick((p) => (p === s ? null : s));

  // the live/closed bar, each part a button
  const bar = (l: number, c: number) => {
    const total = l + c;
    const share = (n: number) => (total ? (n / total) * 100 : 0);
    return (
      <div className="life-bar" role="group" aria-label="Still live or closed">
        {(
          [
            ["live", "still live", l],
            ["closed", "closed", c],
          ] as const
        ).map(([side, label, n]) => (
          <button
            key={side}
            type="button"
            className={`life-seg life-${side}${pick === side ? " is-on" : ""}${pick && pick !== side ? " is-off" : ""}`}
            style={{ width: `${share(n)}%` }}
            aria-pressed={pick === side}
            onClick={() => toggle(side)}
            title={`${n.toLocaleString("en-US")} programs`}
          >
            <span className="life-seg-label">{label}</span>
            <span className="life-seg-share">{fmt(share(n))}%</span>
          </button>
        ))}
      </div>
    );
  };

  const upgradeBlock = upgradeWithin ? (
    <>
      <div className="life-panel-head">
        <SectionHeader title="Upgrade rate" info={upgradeInfo} />
      </div>
      <div className="sub-label">Upgraded again within</div>
      <MeterList rows={upgradeWithin} />
      {medianGap ? <CardFoot label="median time between upgrades" value={medianGap.main} devValue={medianGap.dev} /> : null}
    </>
  ) : null;
  const clonesBlock = clones ? (
    <>
      <div className="life-panel-head">
        <SectionHeader
          title="Byte-clones"
          info="New deploys whose bytecode is byte-for-byte the same as code already on record: the same program under a fresh id. Pump.fun: the clones that reference Pump.fun. Share of the window's live new deploys."
        />
      </div>
      <MeterList rows={clones} />
    </>
  ) : null;
  const closedBlock = closedWithin ? (
    <>
      <div className="life-panel-head">
        <SectionHeader
          title="How fast they closed"
          info="Of the programs first deployed in the window that are already closed (ProgramData gone, rent reclaimed): the share closed within each time of their deploy. Closures are tracked on mainnet only."
        />
      </div>
      <div className="sub-label">Closed within</div>
      <MeterList rows={closedWithin} />
      {medianLife ? (
        <CardFoot label="median lifespan of closed programs" value={medianLife.main} devValue={medianLife.dev} />
      ) : null}
    </>
  ) : null;

  return (
    <div className="life">
      {showSplit ? <div className="sub-label">Deployed {windowLabel}</div> : null}
      {showSplit ? bar(live, closed) : null}

      {/* Always the card's two columns, never a width in between. Nothing
          picked: live on the left, closed on the right. Live picked: its two
          parts side by side. Closed picked: it keeps the left column. */}
      <div className="life-panels">
        {pick === "live" || !showSplit ? (
          <>
            <div className="life-panel">{upgradeBlock}</div>
            <div className="life-panel">{clonesBlock}</div>
          </>
        ) : pick === "closed" ? (
          <div className="life-panel">{closedBlock}</div>
        ) : (
          <>
            <div className="life-panel">
              {upgradeBlock}
              {clonesBlock ? <div className="life-panel-next">{clonesBlock}</div> : null}
            </div>
            <div className="life-panel">{closedBlock}</div>
          </>
        )}
      </div>
    </div>
  );
}
