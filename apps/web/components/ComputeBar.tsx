import type { ComputeProfileData, ComputeRankData } from "@/lib/api";

/** the ceiling one Solana transaction may burn — the bar's right edge */
const TX_CU_LIMIT = 1_400_000;
/** a log axis needs a floor; below this nothing meaningful happens anyway */
const LOG_MIN = 100;

const cu = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

/** "4h ago" — coarse on purpose. The point is to stop the numbers reading as
 *  live, not to be precise about staleness. */
function sampleAge(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return "recently";
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** How much more a transaction reserved than it burned. Capped, because a
 *  program using 1% of a 1.2M reservation produces a number that reads as a
 *  typo rather than a finding. */
function overRequest(utilisation: number): string {
  const over = 1 / utilisation - 1;
  return over > 9.99 ? ">999%" : `${Math.round(over * 100)}%`;
}

/**
 * Compute per transaction, drawn — the same reading the share card draws, from
 * the same sampler (apps/ingest/src/compute.ts), plus the things the card has
 * no room for: the rank against the corpus, how many sampled transactions set
 * no limit at all, and the failure rate.
 *
 * Two numbers, and the gap between them is the point. SGP-0003 proposed
 * charging a resource fee per compute unit REQUESTED, so a program reserving
 * 1.2M and burning 8.6k would pay for 1.2M. Requested is what it costs to ask;
 * consumed is what the work cost.
 */
export function ComputeBar({
  compute,
  rank = null,
}: {
  compute: ComputeProfileData;
  rank?: ComputeRankData | null;
}) {
  // Log, not linear. Against a 1.4M ceiling a linear axis collapses everything
  // under 20k into the first pixel, and most programs live down there.
  const pos = (v: number) => {
    const c = Math.min(Math.max(v, LOG_MIN), TX_CU_LIMIT);
    return (Math.log10(c / LOG_MIN) / Math.log10(TX_CU_LIMIT / LOG_MIN)) * 100;
  };
  const lo = pos(compute.p10);
  const hi = pos(compute.p90);
  const band = Math.max(0.6, hi - lo);
  const req = compute.requestedMedian ? pos(compute.requestedMedian) : null;
  // A reading taken before the spread existed has no `max` and no requested
  // figure. The API ages those out, but one can still be in hand here — draw
  // what it has rather than a bar with a marker at NaN%.
  const hasMax = typeof compute.max === "number";
  // A reading from before those fields existed. Absent is not zero and not
  // "none": this reading cannot say whether anything set a compute limit, and
  // must not be rendered as if it had checked and found nothing.
  const partial = !hasMax || typeof compute.noLimit !== "number";
  const utilisation = compute.utilisation ?? null;

  return (
    <div className="cu">
      {/* No title here — the section header above already says it, and saying
          it twice is the thing that reads as filler. */}
      <div className="cu-head">
        <span className="cu-sub">
          {compute.n} txns · {sampleAge(compute.sampledAt)}
        </span>
      </div>

      <div className="cu-track" role="img" aria-label={`median ${compute.median} compute units, ${compute.p10} to ${compute.p90} for most calls${hasMax ? `, heaviest ${compute.max}` : ""}${compute.requestedMedian ? `, reserves ${compute.requestedMedian}` : ""}`}>
        <div className="cu-band" style={{ left: `${lo}%`, width: `${band}%` }} />
        {hasMax ? <div className="cu-max" style={{ left: `${pos(compute.max!)}%` }} /> : null}
        {req !== null ? <div className="cu-req" style={{ left: `${req}%` }} /> : null}
        <div className="cu-median" style={{ left: `${pos(compute.median)}%` }} />
      </div>
      <div className="cu-axis">
        <span>100</span>
        <span>1.4M cap · log</span>
      </div>

      <div className="cu-legend">
        <span className="cu-key"><i className="cu-k-band" />middle 80%</span>
        <span className="cu-key"><i className="cu-k-median" />median burned</span>
        {req !== null ? <span className="cu-key"><i className="cu-k-req" />reserved</span> : null}
        {hasMax ? <span className="cu-key"><i className="cu-k-max" />heaviest call</span> : null}
      </div>

      <div className="facts-panel cu-facts">
        <div className="fact-row">
          <span className="fact-label">Burns</span>
          <span className="fact-value">
            <strong>{cu(compute.median)}</strong>{" "}
            <span className="cell-dim">
              {/* p10 === p90 is not a degenerate range, it is the finding: every
                  call in the sample cost the same. "9k–9k" buries it. */}
              {compute.p10 === compute.p90
                ? "· flat across the sample"
                : `· ${cu(compute.p10)}–${cu(compute.p90)}`}
              {hasMax ? ` · max ${cu(compute.max!)}` : ""}
            </span>
          </span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Reserves</span>
          <span className="fact-value">
            {/* Absent is not none: a reading from before this field existed
                never looked, and must not read as "nothing set a limit". */}
            {compute.requestedMedian == null ? (
              <span className="cell-dim">{partial ? "not measured" : "no limit set"}</span>
            ) : (
              <>
                <strong>{cu(compute.requestedMedian)}</strong>{" "}
                <span className="cell-dim">· SetComputeUnitLimit</span>
              </>
            )}
          </span>
        </div>
        {utilisation !== null ? (
          <div className="fact-row">
            <span className="fact-label">Uses</span>
            <span className="fact-value">
              <strong>{Math.round(utilisation * 100)}%</strong>{" "}
              <span className="cell-dim">of it · over-requests {overRequest(utilisation)}</span>
            </span>
          </div>
        ) : null}
        {utilisation !== null && rank ? (
          <div className="fact-row">
            <span className="fact-label">Rank</span>
            <span className="fact-value">
              {rank.below === null ? (
                <span className="cell-dim">{rank.n} on record — too few to rank</span>
              ) : (
                <>
                  <strong>lower than {Math.round(rank.below * 100)}%</strong>{" "}
                  <span className="cell-dim">
                    of {rank.n.toLocaleString("en-US")} on record
                    {rank.median !== null ? ` · median ${Math.round(rank.median * 100)}%` : ""}
                  </span>
                </>
              )}
            </span>
          </div>
        ) : null}
        {typeof compute.noLimit === "number" ? (
          <div className="fact-row">
            <span className="fact-label">No limit set</span>
            <span className="fact-value">
              {compute.noLimit} <span className="cell-dim">of {compute.n}</span>
            </span>
          </div>
        ) : null}
        <div className="fact-row">
          <span className="fact-label">Failed</span>
          <span className="fact-value">
            {compute.failed} <span className="cell-dim">of {compute.n}</span>
            {compute.cheapShare ? (
              <span className="cell-dim"> · {Math.round(compute.cheapShare * 100)}% under 2k</span>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
