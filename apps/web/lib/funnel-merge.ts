import type { ApiFunnel } from "@/lib/api";

// "All networks" on the stats page: the API counts each network on its own and
// keeps both counted, so both are fetched and added here. Counts add up.
// The first-half vs second-half share changes do not (the halves' totals
// aren't in the response), so a combined funnel carries none: `combined`
// tells the page to leave the arrows out.

export type StatsFunnel = ApiFunnel & { combined?: boolean };

type Counts = Record<string, number>;

function addMaps(a?: Counts, b?: Counts): Counts | undefined {
  if (!a && !b) return undefined;
  const out: Counts = { ...(a ?? {}) };
  for (const [k, n] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Field-by-field sum of two objects of counts; undefined when both are. */
function addObj<T extends object>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a } as Record<string, number>;
  for (const [k, n] of Object.entries(b as Record<string, number>)) out[k] = (out[k] ?? 0) + n;
  return out as T;
}

/** Two records of the same shape, merged key by key; `both` combines a key
 *  present in each. Undefined when neither side has the record. */
function addKeyed<T>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  both: (x: T, y: T) => T,
): Record<string, T> | undefined {
  if (!a || !b) return a && b ? a : undefined;
  const out: Record<string, T> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? both(out[k]!, v) : v;
  return out;
}

const SBPF_ORDER = ["v3", "v2", "v1", "v0", "other", "not read"];

export function mergeFunnels(main: ApiFunnel, dev: ApiFunnel): StatsFunnel {
  const fwCurrent: Counts = {};
  for (const t of [...(main.frameworkTrend ?? []), ...(dev.frameworkTrend ?? [])])
    fwCurrent[t.framework] = (fwCurrent[t.framework] ?? 0) + t.current;

  const sbpfCurrent: Counts = {};
  for (const t of [...(main.sbpfTrend ?? []), ...(dev.sbpfTrend ?? [])])
    sbpfCurrent[t.version] = (sbpfCurrent[t.version] ?? 0) + t.current;

  const sbpfFw = new Map<string, { framework: string; total: number; read: number; v3: number }>();
  for (const f of [...(main.sbpfByFramework ?? []), ...(dev.sbpfByFramework ?? [])]) {
    const row = sbpfFw.get(f.framework) ?? { framework: f.framework, total: 0, read: 0, v3: 0 };
    row.total += f.total;
    row.read += f.read;
    row.v3 += f.v3;
    sbpfFw.set(f.framework, row);
  }

  // framework counts per bucket add up when both networks used the same
  // bucket; with only one network's series there is no honest combined one
  let frameworkSeries: ApiFunnel["frameworkSeries"] = undefined;
  if (main.frameworkSeries && dev.frameworkSeries && main.frameworkSeries.bucketSecs === dev.frameworkSeries.bucketSecs) {
    const byT = new Map<number, Counts>();
    for (const p of [...main.frameworkSeries.points, ...dev.frameworkSeries.points])
      byT.set(p.t, addMaps(byT.get(p.t), p.counts)!);
    frameworkSeries = {
      bucketSecs: main.frameworkSeries.bucketSecs,
      points: [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, counts]) => ({ t, counts })),
      // devnet has no archive: before this, the combined series is mainnet alone
      archiveUntil: main.frameworkSeries.archiveUntil ?? null,
    };
  }

  const addRows = (
    a: { version: string; total: number; verified: number }[] = [],
    b: { version: string; total: number; verified: number }[] = [],
  ) => {
    const m = new Map<string, { version: string; total: number; verified: number }>();
    for (const r of [...a, ...b]) {
      const row = m.get(r.version) ?? { version: r.version, total: 0, verified: 0 };
      row.total += r.total;
      row.verified += r.verified;
      m.set(r.version, row);
    }
    return [...m.values()].sort((x, y) => y.total - x.total);
  };
  const buildSetup =
    main.buildSetup && dev.buildSetup
      ? {
          total: main.buildSetup.total + dev.buildSetup.total,
          cratesRead: main.buildSetup.cratesRead + dev.buildSetup.cratesRead,
          sdk: addRows(main.buildSetup.sdk, dev.buildSetup.sdk),
          anchor: addRows(main.buildSetup.anchor, dev.buildSetup.anchor),
          pinocchio: addRows(main.buildSetup.pinocchio, dev.buildSetup.pinocchio),
          machine: addRows(main.buildSetup.machine, dev.buildSetup.machine),
        }
      : undefined;

  return {
    ...main,
    combined: true,
    buildSetup,
    frameworkSeries,
    raw: main.raw + dev.raw,
    unique: main.unique + dev.unique,
    novel: main.novel + dev.novel,
    clones: main.clones + dev.clones,
    variants: main.variants + dev.variants,
    deploys: main.deploys + dev.deploys,
    upgrades: main.upgrades + dev.upgrades,
    capped: main.capped || dev.capped,
    byCategory: addMaps(main.byCategory, dev.byCategory) ?? {},
    byFramework: addMaps(main.byFramework, dev.byFramework),
    byIntegration: addMaps(main.byIntegration, dev.byIntegration),
    byCapability: addMaps(main.byCapability, dev.byCapability),
    identity: addObj(main.identity, dev.identity),
    lineage: addObj(main.lineage, dev.lineage),
    control: addObj(main.control, dev.control),
    conviction: addObj(main.conviction, dev.conviction),
    buildMachine: addObj(main.buildMachine, dev.buildMachine),
    churn: addObj(main.churn, dev.churn),
    disclosure: addObj(main.disclosure, dev.disclosure),
    authority: addObj(main.authority, dev.authority),
    disclosureByAuthority: addKeyed(main.disclosureByAuthority, dev.disclosureByAuthority, (a, b) => addObj(a, b)!),
    toolchainByFramework: addKeyed(main.toolchainByFramework, dev.toolchainByFramework, (a, b) => ({
      sbpf: addMaps(a.sbpf, b.sbpf) ?? {},
      integrations: addMaps(a.integrations, b.integrations) ?? {},
      v0Upgrades: a.v0Upgrades + b.v0Upgrades,
      machine: addKeyed(a.machine, b.machine, (x, y) => addObj(x, y)!) ?? {},
    })),
    // counts add up; medians do not, so the combined view leaves them out
    lifecycle:
      main.lifecycle && dev.lifecycle
        ? {
            live: main.lifecycle.live + dev.lifecycle.live,
            closed: main.lifecycle.closed + dev.lifecycle.closed,
            lifespan: {
              buckets: main.lifecycle.lifespan.buckets.map((n, i) => n + (dev.lifecycle!.lifespan.buckets[i] ?? 0)),
              median: null,
              n: main.lifecycle.lifespan.n + dev.lifecycle.lifespan.n,
            },
            upgradeGap: {
              buckets: main.lifecycle.upgradeGap.buckets.map((n, i) => n + (dev.lifecycle!.upgradeGap.buckets[i] ?? 0)),
              median: null,
              n: main.lifecycle.upgradeGap.n + dev.lifecycle.upgradeGap.n,
              noEarlier: main.lifecycle.upgradeGap.noEarlier + dev.lifecycle.upgradeGap.noEarlier,
            },
          }
        : undefined,
    lostVerification:
      main.lostVerification != null && dev.lostVerification != null
        ? main.lostVerification + dev.lostVerification
        : undefined,
    sbpfUpgrades: addMaps(main.sbpfUpgrades, dev.sbpfUpgrades),
    frameworkTrend: main.frameworkTrend || dev.frameworkTrend
      ? Object.entries(fwCurrent)
          .map(([framework, current]) => ({ framework, current, earlyShare: 0, lateShare: 0, delta: 0 }))
          .sort((a, b) => b.current - a.current)
      : undefined,
    sbpfTrend: main.sbpfTrend || dev.sbpfTrend
      ? SBPF_ORDER.filter((v) => v.startsWith("v") || sbpfCurrent[v]).map((version) => ({
          version,
          current: sbpfCurrent[version] ?? 0,
          earlyShare: null,
          lateShare: null,
          delta: null,
        }))
      : undefined,
    sbpfByFramework: sbpfFw.size ? [...sbpfFw.values()].sort((a, b) => b.total - a.total) : undefined,
  };
}
