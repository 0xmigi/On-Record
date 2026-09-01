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
 * What a transaction here costs, drawn as one distribution against one ceiling.
 *
 * THE LABELS ARE SOLANA'S OWN VOCABULARY, NOT PLAIN-ENGLISH INVENTIONS. The
 * chain calls these things `computeUnitsConsumed` and the compute unit limit
 * set by `SetComputeUnitLimit` (capped at MAX_COMPUTE_UNIT_LIMIT, 1,400,000).
 * An earlier pass here
 * shipped "typical call", "middle 80%", "heaviest" and "asked for" — invented
 * phrasings that made a reader stop and work out what was meant. If a label
 * needs a gloss, the term is wrong.
 *
 * MEDIAN, NEVER MEAN, AND THE LABEL SAYS SO. Drift V2's mean is dragged to
 * ~12k by a single 343k outlier over a body of 8,586 — a number no transaction
 * ever cost. "median consumed" is the honest label; "average" would not be.
 *
 * THE UNIT IS A TRANSACTION, AND THE LABELS HAVE TO SAY SO. `computeUnitsConsumed`
 * is transaction-level — a swap pays for this program plus every program it
 * routes through — and the sampler iterates over signatures, so `n`, `failed`,
 * `noLimit` and `selfN` are every one a count of transactions. Calling them
 * "calls" reads as invocations of THIS program, which is the single conflation
 * the whole metric exists to avoid. Only the `this program` row is per-program,
 * and it says so.
 *
 * THREE THINGS AND NOTHING ELSE: the range of what calls actually burn, the
 * typical call inside it, and the compute the transaction reserved. All of it
 * is one population — every sampled call, transaction-level CU — on one linear
 * axis from zero, so nothing here is a ratio and nothing can contradict
 * anything else.
 *
 * That is the whole design, and it replaced a segmented bar that tried to hold
 * five figures taken over five different subsets of the sample. Dividing them
 * into each other produced real lies on real programs: an own-burn clamped from
 * 162k to 25k to keep a segment non-negative, "uses 100% of it" printed above
 * "burns 15k", and a bar drawn completely full for the fifth of the corpus that
 * reserves nothing at all. None of those failures are reachable from a drawing
 * that never divides.
 *
 * The two figures that are NOT this population — the program's own burn, and
 * the corpus rank — are sentences underneath, each carrying the count it rests
 * on. They are not marks on this axis.
 *
 * Linear from zero, not log. A log axis makes the reader decode a scale before
 * reading a number. Where a linear axis squashes the whole distribution into a
 * sliver, that is not a rendering failure — it IS the finding, and it is rare:
 * across 292 readings the distribution covers more than half the axis for 69%
 * of programs, and collapses under a tenth for 6.5%.
 */
export function ComputeBar({
  compute,
  rank = null,
}: {
  compute: ComputeProfileData;
  rank?: ComputeRankData | null;
}) {
  // A reading taken before the spread and the requested figure existed carries
  // a median and a band and nothing else. Absent is not none.
  const partial = typeof compute.max !== "number" || typeof compute.noLimit !== "number";

  // The whisker. `min` and `max` arrived after the first readings were written,
  // so an older row falls back to its band — a narrower whisker, never a wrong
  // one.
  // WHOSE COMPUTE THIS IS. The point of the section is what THIS program costs
  // to call, so the axis draws this program's own consumption — read per
  // invocation off the runtime's `Program <id> consumed <n> of <m> compute
  // units` log lines, CPI passes included. It used to draw the whole
  // transaction, which on a swap is this program plus every program it routes
  // through: a number about the traffic, not about the program.
  //
  // The transaction total does not disappear, it becomes a row. And when there
  // is no attribution — an older reading, or a program merely named in the
  // sampled transactions and never executed — the axis falls back to the
  // transaction and every label says so, because the alternative is drawing
  // nothing.
  const own = typeof compute.selfMedian === "number";
  const mid = own ? compute.selfMedian! : compute.median;
  const p90 = own && typeof compute.selfP90 === "number" ? compute.selfP90 : compute.p90;
  const lo = own
    ? (typeof compute.selfMin === "number" ? compute.selfMin : p90)
    : typeof compute.min === "number"
      ? compute.min
      : compute.p10;
  const hi = own
    ? (typeof compute.selfMax === "number" ? compute.selfMax : p90)
    : typeof compute.max === "number"
      ? compute.max
      : compute.p90;
  // The CU limit and the transaction total, over THIS PROGRAM'S TRANSACTIONS
  // when the reading carries them. Falling back to the all-sampled figures is
  // what put a 39k per-program median beside a 27k transaction median computed
  // over 62 transactions that never ran the program.
  const ceiling =
    (own ? (compute.ranRequestedMedian ?? compute.requestedMedian) : compute.requestedMedian) ?? null;
  const txnTotal = own ? (compute.ranMedian ?? compute.median) : compute.median;
  const ranPopulation = own && typeof compute.ranMedian === "number";

  // The CU limit's own range, when the reading carries it. It is a DISTRIBUTION,
  // not one number per program — transactions choose their own limit and the
  // heavy ones choose bigger. Kamino's sampled limits run 62k–200k. Old readings
  // carry only the median, and then the single dashed rule is all that can
  // honestly be drawn.
  const limitLo =
    (own ? (compute.ranRequestedMin ?? compute.requestedMin) : compute.requestedMin) ?? null;
  const limitHi =
    (own ? (compute.ranRequestedMax ?? compute.requestedMax) : compute.requestedMax) ?? null;

  // 4% of slack past whichever is further right, so a ceiling that IS the
  // maximum still draws as a rule inside the track rather than under the border.
  // Room past whichever is furthest right, so the CU limit draws as a MARK
  // inside the chart rather than vanishing into the track's own border. Making
  // the axis end exactly at the limit removed the one thing the section is
  // about — there was nothing left to point at.
  // Where the rail starts. Never zero: a program's cheapest instruction still
  // costs something, and claiming otherwise is a measurement we never took.
  const rangeLo = typeof compute.selfMin === "number" ? compute.selfMin : mid;
  // Whether the CU limit belongs to this program or to a transaction it shares.
  // Below ~95% of the bill the gap to the limit is NOT this program's headroom —
  // most of it is budget for the other programs in the same transaction. Orca is
  // 21% of its transactions, so drawing 39k against a 305k limit implied 266k of
  // room it does not have.
  const sharesTxn = compute.selfShare != null && compute.selfShare < 0.95;
  const span = Math.max(hi, p90, mid, ceiling ?? 0, compute.selfMax ?? 0, 1) * 1.08;
  const at = (v: number) => (Math.min(Math.max(v, 0), span) / span) * 100;

  // What the reservation rests on. It is a median over the calls that set a
  // limit, while everything drawn above is over every call — so when that is a
  // minority of the sample it gets said, and never stated as the program's.
  const withLimit = typeof compute.noLimit === "number" ? compute.n - compute.noLimit : null;
  const thinLimit = withLimit !== null && withLimit > 0 && withLimit < compute.n * 0.5;
  // Impossible inside one transaction — the runtime aborts at the limit — so it
  // only ever means the calls that set a limit are not the calls doing the work.
  const ceilingUnderBurn = ceiling !== null && ceiling < compute.median;

  const selfN = typeof compute.selfN === "number" ? compute.selfN : null;
  const selfMedian = typeof compute.selfMedian === "number" ? compute.selfMedian : null;
  const failedShare = compute.n > 0 ? compute.failed / compute.n : 0;

  return (
    <div className="cu">
      {/* ONE PROGRAM, drawn as the RANGE it actually burns.
          The rail used to start at zero, which asserted that its cheapest call
          costs nothing. It doesn't — a program's instructions each cost
          something, and the floor is `selfMin`. Filling from zero was a
          magnitude encoding wearing a range's clothes.

          Where `selfMin` is missing (readings taken before it existed) the rail
          starts at the median and says so, rather than inventing a floor. */}
      <div className="cu-track cu-track-thin">
        <div
          className="cu-rail"
          style={{ left: `${at(rangeLo)}%`, width: `${Math.max(at(p90) - at(rangeLo), 0)}%` }}
        />
        {typeof compute.selfMax === "number" && compute.selfMax > p90 ? (
          <div
            className="cu-rail-tail"
            style={{ left: `${at(p90)}%`, width: `${at(compute.selfMax) - at(p90)}%` }}
          />
        ) : null}
        <div className="cu-median" style={{ left: `${at(mid)}%` }} />
        {ceiling !== null ? <div className="cu-ceiling" style={{ left: `${at(ceiling)}%` }} /> : null}
      </div>
      <p className="cu-scale">
        <span className="cu-dim">0</span>
        {ceiling !== null ? (
          at(ceiling) > 74 ? (
            <span className="cu-scale-at cu-dim" style={{ right: 0 }}>
              {cu(ceiling)} CU limit{sharesTxn ? " (whole txn)" : ""}
            </span>
          ) : (
            <span
              className="cu-scale-at cu-dim"
              style={{ left: `${at(ceiling)}%`, transform: "translateX(-50%)" }}
            >
              {cu(ceiling)} CU limit{sharesTxn ? " (whole txn)" : ""}
            </span>
          )
        ) : (
          <span className="cu-scale-at cu-dim" style={{ right: 0 }}>
            {cu(span)} CU
          </span>
        )}
      </p>

      {/* Labelled rows, not sentences. The axis carries the shape; every number
          you would quote lives here against the plainest label for it, one fact
          per row, in the same label/value idiom as the rest of the page.

          THE ROWS ARE ALSO THE LEGEND. Each row that describes a mark on the
          axis carries that mark, drawn the same way, so nothing has to be
          matched up from a separate key — and the rows with no glyph are
          exactly the figures that are NOT on the axis. The absence is the
          point: own burn and corpus rank are medians over different sets of
          calls, and a reader must not go looking for them on that bar. */}
      <dl className="cu-rows">
        <div className="cu-row">
          <dt>
            <i className="cu-g cu-g-rail" />
            {own ? "median" : "median, whole txn"}
          </dt>
          <dd>
            {cu(mid)}
            {own ? null : <span className="cu-dim"> · this program not attributed</span>}
          </dd>
        </div>

        {/* p90 alone, not p10–p90. On 44% of readings p10 sits within 20% of the
            median, and `min` already says what the cheapest one cost. p90 is the
            only figure separating a freak from a pattern: median 6,359 / max
            204,375 and median 2,520 / max 212,600 look identical until you see
            p90s of 9,087 and 206,856. It carries its own gloss because the bare
            term did not survive contact with a reader. */}
        <div className="cu-row">
          <dt>
            <i className="cu-g cu-g-rail-tail" />
            p90
          </dt>
          <dd>
            {p90 <= mid ? (
              <>
                {cu(p90)} <span className="cu-dim">· no heavier tail than the median</span>
              </>
            ) : (
              <>
                {cu(p90)} <span className="cu-dim">· 1 in 10 burned more</span>
              </>
            )}
          </dd>
        </div>

        {lo !== hi ? (
          <div className="cu-row">
            <dt>
              <i className="cu-g cu-g-range" />
              min–max
            </dt>
            <dd>
              {cu(lo)} – {cu(hi)}
            </dd>
          </div>
        ) : null}

        <div className="cu-row">
          <dt>
            {ceiling !== null ? <i className="cu-g cu-g-ceiling" /> : <i className="cu-g" />}
            cu limit
          </dt>
          <dd>
            {partial ? (
              <span className="cu-dim">not measured — this reading predates the figure</span>
            ) : ceiling === null ? (
              <span className="cu-dim">none set — no SetComputeUnitLimit, so the per-instruction default applies</span>
            ) : (
              <>
                {cu(ceiling)}{" "}
                <span className="cu-dim">
                  {ceilingUnderBurn
                    ? `· set by ${withLimit} of ${compute.n} transactions, and below what a transaction here burns`
                    : thinLimit
                      ? `· set by only ${withLimit} of ${compute.n} transactions`
                      : limitLo !== null && limitHi !== null && limitLo !== limitHi
                        ? `median · limits of ${cu(limitLo)} to ${cu(limitHi)} set across the sample`
                        : sharesTxn
                      ? `median · the whole transaction's, of which this program is ${Math.round((compute.selfShare ?? 0) * 100)}%`
                      : "median · set per transaction, for the whole transaction"}
                </span>
              </>
            )}
          </dd>
        </div>

        {/* Not attributed at all — an older reading, or a program merely named in
            the sampled transactions and never executed. Distinct from "this
            program is effectively the whole transaction", which is why these are
            two conditions and not one ternary. */}
        {!own ? (
          <div className="cu-row">
            <dt>
              <i className="cu-g" />
              this program
            </dt>
            <dd className="cu-dim">
              {compute.selfMedian === undefined
                ? "not measured — this reading predates per-program attribution"
                : "never executed — it was named in the transactions, not called"}
            </dd>
          </div>
        ) : compute.selfShare != null && compute.selfShare >= 0.98 ? null : (
          /* The transaction total. Only worth a row when this program is NOT
             effectively all of it — otherwise it restates the median above. */
          <div className="cu-row">
            <dt>
              <i className="cu-g" />
              whole txn
            </dt>
            <dd>
              {cu(txnTotal)}{" "}
              <span className="cu-dim">
                {ranPopulation
                  ? `median${compute.selfShare != null ? ` · this program is ${Math.round(compute.selfShare * 100)}% of it` : ""}`
                  : `median across all ${compute.n} sampled${
                      compute.selfShare != null
                        ? ` · this program is ${Math.round(compute.selfShare * 100)}% of it, on the ${selfN} that ran it`
                        : ""
                    }`}
              </span>
            </dd>
          </div>
        )}

        {/* What the reading rests on. n=12 and n=100 rendered identically until
            this row existed, and a sample that is 98% failed was reported as
            "typical". `selfN` lives here now: it is the denominator for every
            figure on the axis. */}
        <div className="cu-row">
          <dt>
            <i className="cu-g" />
            sample
          </dt>
          <dd className="cu-dim">
            {compute.n} transaction{compute.n === 1 ? "" : "s"}, {sampleAge(compute.sampledAt)}
            {own && selfN !== null ? (
              <> · {selfN === compute.n ? "all" : selfN} ran this program</>
            ) : null}
            <span className={failedShare > 0.5 ? "cu-warn" : undefined}> · {compute.failed} failed</span>
            {typeof compute.noLimit === "number" && compute.noLimit > 0 ? (
              <> · {compute.noLimit} with no CU limit</>
            ) : null}
          </dd>
        </div>
      </dl>
    </div>
  );
}
