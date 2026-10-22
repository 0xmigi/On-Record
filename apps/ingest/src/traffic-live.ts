import { readTraffic, sampleTrafficNow, type Network, type StoredSample, type TrafficSample } from "@onrecord/core";

// ---------------------------------------------------------------------------
// ?sample=live on the dossier: re-measure traffic now, within a budget.
//
// The dossier route is an unauthenticated GET, and a live traffic sample costs
// about 21 Helius credits (a signature page and two Parsed Events calls). With
// no bound, iterating program ids with ?sample=live spends the plan; on Helius
// Free (1M credits a month) that is about 47,000 requests. The same three
// bounds as the usage filler (routes/public.ts):
//
//   stale-only  a sample newer than LIVE_STALE_MS is served as-is. "Live" is
//               for when "as of 9 hours ago" is not good enough, not 9 minutes.
//   one-flight  concurrent requests for one program share one measurement.
//   budget      a fixed hourly ceiling across all programs. Worst case is
//               LIVE_MAX_PER_HOUR x ~21 credits an hour, whatever comes in.
//
// Past either bound the dossier still renders, from the stored sample, and
// says why it is not live.
// ---------------------------------------------------------------------------

/** how old the stored sample must be before ?sample=live pays to replace it */
export const LIVE_STALE_MS = Number(process.env.TRAFFIC_LIVE_STALE_MS ?? 3_600_000);
/** live traffic samples per hour, process-wide: ~210 credits an hour at most */
const LIVE_MAX_PER_HOUR = Number(process.env.TRAFFIC_LIVE_MAX_PER_HOUR ?? 10);

/** why a live sample was not taken, when it was not */
export type LiveDecline = "fresh" | "budget";

export interface LiveTraffic {
  sample: StoredSample<TrafficSample>;
  declined: LiveDecline | null;
}

export interface LiveTrafficDeps {
  read: (id: string) => Promise<StoredSample<TrafficSample>>;
  measure: (network: Network, id: string) => Promise<StoredSample<TrafficSample>>;
  /** live samples allowed per hour, across every program */
  maxPerHour: number;
  staleMs: number;
  now: () => number;
}

/** Build the bounded live sampler. Exported with its dependencies for tests;
 *  the dossier uses `liveTraffic` below. */
export function liveTrafficSampler(deps: LiveTrafficDeps) {
  const inFlight = new Map<string, Promise<StoredSample<TrafficSample>>>();
  let windowStart = deps.now();
  let spentThisHour = 0;
  /** claim one slot from this hour's budget, or report that there is none */
  const spend = (): boolean => {
    if (deps.now() - windowStart >= 3_600_000) {
      windowStart = deps.now();
      spentThisHour = 0;
    }
    if (spentThisHour >= deps.maxPerHour) return false;
    spentThisHour++;
    return true;
  };
  return async (network: Network, id: string): Promise<LiveTraffic> => {
    const stored = await deps.read(id);
    const age = stored.sampledAt ? deps.now() - stored.sampledAt.getTime() : Infinity;
    if (age < deps.staleMs) return { sample: stored, declined: "fresh" };
    // join a measurement already running before touching the budget
    let flight = inFlight.get(id);
    if (!flight) {
      if (!spend()) return { sample: stored, declined: "budget" };
      flight = deps.measure(network, id).finally(() => inFlight.delete(id));
      inFlight.set(id, flight);
    }
    return { sample: await flight, declined: null };
  };
}

export const liveTraffic = liveTrafficSampler({
  read: readTraffic,
  measure: (network, id) => sampleTrafficNow(network, id),
  maxPerHour: LIVE_MAX_PER_HOUR,
  staleMs: LIVE_STALE_MS,
  now: Date.now,
});
