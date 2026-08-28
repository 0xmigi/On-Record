import type { ComputeProfileData, ComputeRankData } from "@/lib/api";

const cu = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

/** "4h ago" — coarse on purpose, to stop the numbers reading as live. */
function sampleAge(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return "recently";
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What a call here costs, drawn as one bar.
 *
 * The bar's full width is the RESERVATION — what the transaction asked the
 * scheduler to hold — so the segments answer the three questions in order:
 * how much of that did this program burn, how much did the rest of the
 * transaction burn, and how much was held and never used. That last part is
 * what SGP-0003 would have charged for.
 *
 * Linear, not log. The old bar ran to the 1,400,000 transaction cap on a log
 * axis, which forced the reader to decode a scale before reading a number.
 * Against the reservation the proportions are the point and they are literal.
 *
 * Every figure is a MEDIAN over the sample, never a mean: one 884k outlier
 * drags a mean to a number no transaction ever cost.
 */
export function ComputeBar({
  compute,
  rank = null,
}: {
  compute: ComputeProfileData;
  rank?: ComputeRankData | null;
}) {
  const total = compute.median;
  // Attribution is absent on readings taken before it existed, and null on a
  // program no sampled transaction actually executed. In both cases the total
  // is the transaction's, and calling it "this program" would be a false
  // claim — so the label changes, not just the number.
  const own = typeof compute.selfMedian === "number" ? Math.min(compute.selfMedian, total) : null;
  const reserved = compute.requestedMedian ?? null;
  const partial = typeof compute.max !== "number" || typeof compute.noLimit !== "number";
  // No reservation on record means the bar has nothing to be a fraction of, so
  // it falls back to the burn itself and simply shows no headroom.
  const span = Math.max(reserved ?? total, total, 1);
  const pctOf = (v: number) => (v / span) * 100;
  const rest = own === null ? null : Math.max(0, total - own);
  const headroom = reserved === null ? null : Math.max(0, reserved - total);

  return (
    <div className="cu">
      <div className="cu-bar">
        <div className="cu-seg cu-seg-self" style={{ width: `${pctOf(own ?? total)}%` }} />
        {rest !== null && rest > 0 ? (
          <div className="cu-seg cu-seg-rest" style={{ width: `${pctOf(rest)}%` }} />
        ) : null}
      </div>

      {/* The legend IS the readout — every swatch carries its own number, so
          there is nothing to match up against an axis. */}
      <div className="cu-keys">
        <span className="cu-key">
          <i className="cu-sw cu-sw-self" />
          {own !== null ? "this program" : "burned"} <b>{cu(own ?? total)}</b>
        </span>
        {rest !== null && rest > 0 ? (
          <span className="cu-key">
            <i className="cu-sw cu-sw-rest" />
            rest of txn <b>{cu(rest)}</b>
          </span>
        ) : null}
        {headroom !== null ? (
          <span className="cu-key">
            <i className="cu-sw cu-sw-free" />
            reserved, unused <b>{cu(headroom)}</b>
          </span>
        ) : null}
      </div>

      <p className="cu-line">
        Typical call burns <b>{cu(total)}</b> <span className="cu-dim">(median of {compute.n})</span>
        {compute.p10 !== compute.p90 ? (
          <span className="cu-dim">
            {" "}
            · {cu(compute.p10)}–{cu(compute.p90)} across the sample
          </span>
        ) : (
          <span className="cu-dim"> · flat across the sample</span>
        )}
        {typeof compute.max === "number" ? <span className="cu-dim"> · max {cu(compute.max)}</span> : null}
      </p>

      <p className="cu-line">
        {reserved === null ? (
          <span className="cu-dim">
            {partial ? "Reservation not measured" : "No compute limit set"} · sampled{" "}
            {sampleAge(compute.sampledAt)}
          </span>
        ) : (
          <>
            Reserves <b>{cu(reserved)}</b>, uses{" "}
            <b>{Math.round((compute.utilisation ?? total / reserved) * 100)}%</b> of it
            {rank && rank.below !== null ? (
              <span className="cu-dim">
                {" "}
                · more of its reservation than {Math.round(rank.below * 100)}% of {rank.n} on record
              </span>
            ) : null}
            <span className="cu-dim"> · sampled {sampleAge(compute.sampledAt)}</span>
          </>
        )}
      </p>
    </div>
  );
}
