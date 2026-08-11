import { dueForSample, logger, sampleTrafficNow, sampleUsageNow, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Activity-sample sweep — the ONLY thing that spends Helius credits on usage
// and traffic.
//
// Both used to be computed on a request path: /api/programs/:id/usage ran a
// live 400-transaction parse on every page render, and the dossier sampled 200
// more on every fetch. That put an unauthenticated, uncached, ~400-credit call
// on the public internet, so the bill tracked strangers rather than deploys —
// and a popular post cost more than an unpopular one.
//
// Now requests only record interest (`noteRequested`), and this sweep decides
// what to spend. Two properties matter and both come from the cap:
//
//   bounded   at most MAX programs per tick, whatever the traffic. A crawler
//             pointed at every /p/<id> costs the same as one visitor.
//   targeted  only programs someone actually asked for, within the interest
//             window. The other ~5,000 on record are never sampled.
//
// A program nobody has opened is worth nothing to sample; a program somebody
// opened five minutes ago fills in on the next tick.
// ---------------------------------------------------------------------------

const USAGE_MAX = Number(process.env.SAMPLE_SWEEP_USAGE_MAX ?? 12);
const TRAFFIC_MAX = Number(process.env.SAMPLE_SWEEP_TRAFFIC_MAX ?? 8);

/** How long a sample stays good. Instruction mix and cadence move slowly; a
 *  day-old measurement is honest as long as it is rendered with its timestamp,
 *  which is why every surface shows "as of". */
const USAGE_TTL_MS = Number(process.env.SAMPLE_USAGE_TTL_MS ?? 24 * 3_600_000);
const TRAFFIC_TTL_MS = Number(process.env.SAMPLE_TRAFFIC_TTL_MS ?? 12 * 3_600_000);

/** Only keep refreshing programs someone has looked at this recently. Beyond
 *  it, the stored sample stays readable but stops costing anything to maintain. */
const INTEREST_WINDOW_MS = Number(process.env.SAMPLE_INTEREST_WINDOW_MS ?? 7 * 24 * 3_600_000);

/** How many transactions each sample parses. Lower than the old inline defaults
 *  (400/200): the sample is now taken once per TTL instead of once per view, so
 *  the useful trade moved from "cheap enough to run constantly" to "wide enough
 *  to be representative". These still cost credits — keep them modest. */
const USAGE_PARSE = Number(process.env.SAMPLE_USAGE_PARSE ?? 200);
const TRAFFIC_PARSE = Number(process.env.SAMPLE_TRAFFIC_PARSE ?? 200);
const TRAFFIC_SIGNATURES = Number(process.env.SAMPLE_TRAFFIC_SIGNATURES ?? 1000);

export async function sweepActivitySamples(network: Network = "mainnet"): Promise<void> {
  let usageDone = 0;
  let trafficDone = 0;

  const usageIds = await dueForSample(network, "usage", {
    max: USAGE_MAX,
    staleAfterMs: USAGE_TTL_MS,
    requestedWithinMs: INTEREST_WINDOW_MS,
  });
  for (const id of usageIds) {
    try {
      await sampleUsageNow(network, id, { sample: USAGE_PARSE });
      usageDone++;
    } catch (err) {
      // A failure must not retry in a hot loop — the row keeps its old
      // sampledAt (or stays null) and comes back round on a later tick.
      logger.warn({ id, err: String(err) }, "sample sweep: usage failed");
    }
  }

  const trafficIds = await dueForSample(network, "traffic", {
    max: TRAFFIC_MAX,
    staleAfterMs: TRAFFIC_TTL_MS,
    requestedWithinMs: INTEREST_WINDOW_MS,
  });
  for (const id of trafficIds) {
    try {
      await sampleTrafficNow(network, id, {
        signatures: TRAFFIC_SIGNATURES,
        parse: TRAFFIC_PARSE,
      });
      trafficDone++;
    } catch (err) {
      logger.warn({ id, err: String(err) }, "sample sweep: traffic failed");
    }
  }

  if (usageDone || trafficDone || usageIds.length || trafficIds.length) {
    logger.info(
      { network, usage: usageDone, traffic: trafficDone, usageDue: usageIds.length, trafficDue: trafficIds.length },
      "sample sweep: done",
    );
  }
}
