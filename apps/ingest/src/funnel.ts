import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  db,
  loadHistoryStatsDaily,
  logger,
  schema,
  securityTxtSource,
  type ApiFunnel,
  type Network,
  type ProgramProfile,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Funnel / Program Stats (SPEC §1, §6). A windowed view over the loader stream:
// deploy+upgrade events split into new deploys vs upgrades, and the new
// programs broken down by category, framework, integrations, identity, lineage,
// control and funding — all computed live from events + subjects (the profile
// now rides on subjects.profile). The web Stats page + radar header read this.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const WINDOW_HOURS: Record<string, number> = {
  "24h": 24,
  "48h": 48,
  "7d": 168,
  "30d": 720,
  "90d": 2160,
  "1y": 8760,
};
// "all" = effectively unbounded (10y) so the funnel counts everything on record.
const ALL_HOURS = 24 * 3650;
/** Up to this many hours the chart gets the 30-day hourly series; beyond it,
 *  one point per UTC day over the whole window. */
const HOURLY_MAX_HOURS = 720;

/** Map the web's window key ("24h".."1y", "all") to hours; default 48h. */
export function windowHoursFor(key: string | undefined): number {
  if (key === "all") return ALL_HOURS;
  return WINDOW_HOURS[key ?? ""] ?? 48;
}

// ---------------------------------------------------------------------------
// Finished results, kept in memory. Counting a window takes seconds (tens for
// the long ones), and the page gives up after ten, so a visitor never waits on
// it: they get the stored result, and one older than FRESH_MS is recounted in
// the background for the next visitor. Results outlive restarts (see
// STORE_PREFIX), so only a window never counted before makes anyone wait.
// Counts run one at a time: two long windows at once would
// not fit the heap. The response's updatedAt says how old it is, and the page
// prints it.
// ---------------------------------------------------------------------------

const FRESH_MS = 15 * 60_000;
type CacheEntry = {
  at: number;
  value: ApiFunnel | null;
  pending: Promise<ApiFunnel> | null;
  /** reading the stored copy (see below); settles once per process */
  loading: Promise<void> | null;
};
const funnelCache = new Map<string, CacheEntry>();
let queue: Promise<unknown> = Promise.resolve();

// Every finished count is also written to the config table, so a restart (each
// deploy is one) starts from the last result instead of an empty cache. Without
// it the long windows answered nothing for the minutes their first count took.
// The version in the key retires stored copies when the response shape changes.
const STORE_PREFIX = "funnel-cache:v1:";

async function loadStored(id: string, entry: CacheEntry): Promise<void> {
  try {
    const rows = await db
      .select({ value: schema.config.value, at: schema.config.updatedAt })
      .from(schema.config)
      .where(eq(schema.config.key, STORE_PREFIX + id));
    const row = rows[0];
    if (row && !entry.value) {
      entry.value = row.value as ApiFunnel;
      entry.at = new Date(row.at).getTime();
    }
  } catch (err) {
    logger.warn({ err: String(err), id }, "funnel: stored copy unreadable");
  }
}

async function store(id: string, value: ApiFunnel): Promise<void> {
  const key = STORE_PREFIX + id;
  await db
    .insert(schema.config)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.config.key, set: { value, updatedAt: new Date() } });
}

function recount(id: string, hours: number, network: Network, entry: CacheEntry): Promise<ApiFunnel> {
  if (entry.pending) return entry.pending;
  const run = queue.then(async () => {
    const t0 = Date.now();
    const value = await computeWindowFunnel(hours, network);
    logger.info({ hours, network, ms: Date.now() - t0 }, "funnel: counted");
    entry.value = value;
    entry.at = Date.now();
    await store(id, value).catch((err) => logger.warn({ err: String(err), id }, "funnel: store failed"));
    return value;
  });
  entry.pending = run.finally(() => {
    entry.pending = null;
  });
  queue = entry.pending.catch(() => undefined);
  return entry.pending;
}

/** The funnel for a window key, from the cache when it holds one. */
export async function cachedWindowFunnel(key: string | undefined, network: Network): Promise<ApiFunnel> {
  const hours = windowHoursFor(key);
  const id = `${network}:${hours}`;
  let entry = funnelCache.get(id);
  if (!entry) {
    entry = { at: 0, value: null, pending: null, loading: null };
    funnelCache.set(id, entry);
  }
  if (!entry.value) {
    entry.loading ??= loadStored(id, entry);
    await entry.loading;
  }
  if (!entry.value) return recount(id, hours, network, entry);
  if (Date.now() - entry.at > FRESH_MS) {
    recount(id, hours, network, entry).catch((err) =>
      logger.warn({ err: String(err), hours, network }, "funnel: background recount failed"),
    );
  }
  return entry.value;
}

/** Count every window the page offers once, so the first visitors after a
 *  restart get a stored result too. One at a time, through the same queue. */
export async function warmFunnelCache(): Promise<void> {
  const keys = ["24h", "48h", "7d", "30d", "90d", "1y", "all"];
  for (const network of ["mainnet", "devnet"] as const)
    for (const key of keys) {
      if (network === "devnet" && key === "1y") continue; // the page offers no devnet 1y
      await cachedWindowFunnel(key, network).catch((err) =>
        logger.warn({ err: String(err), key, network }, "funnel: warm failed"),
      );
    }
}

type SubjectLite = {
  sha256: string | null;
  noveltyBand: string | null;
  category: string | null;
  name: string | null;
  repoUrl: string | null;
  authorityClass: string | null;
  verified: boolean;
  idlPresent: boolean;
  entityKey: string | null;
  deployerFundingSource: string | null;
  profile: ProgramProfile | null;
  deployType: string | null;
  firstSeenAt: Date | null;
  facts: Record<string, unknown> | null;
};

/** The framework a program is counted under on the stats page. Two of them
 *  the bare profile hides: Anchor v2 (a rewrite on Pinocchio — its own line
 *  in profile.anchor, but still `anchor` in profile.framework) and Quasar,
 *  which the binary reads as Pinocchio and only its source can name
 *  (source-framework.ts). Same precedence as the serializer: never relabel
 *  an Anchor binary from source. */
function frameworkKey(s: SubjectLite): string {
  const fw = s.profile?.framework ?? "unknown";
  const source = (s.facts?.sourceFramework as { framework?: string | null } | undefined)?.framework;
  if (source && fw !== "anchor") return source;
  if (fw === "anchor" && s.profile?.anchor?.line === "2.x") return "anchor v2";
  return fw;
}

/** Shown even at zero, so the panel says "none this window" rather than
 *  leaving it unclear whether these are tracked at all. */
const ALWAYS_LISTED = ["anchor v2", "quasar"];

/** The rich funnel for a trailing window. */
export async function computeWindowFunnel(
  windowHours: number,
  network: Network = "mainnet",
): Promise<ApiFunnel> {
  const now = Date.now();
  const windowStart = new Date(now - windowHours * HOUR);

  // When each cluster's record actually begins — the first row we ever WROTE,
  // not the earliest block time (genesis deploys reach back years). Anything
  // left of this is either absent or came from a one-off backfill, which can
  // only recover programs whose ProgramData still points at that old slot, so
  // it systematically undercounts. The chart marks it rather than letting the
  // run-up read as a surge in deploys. Derived, never hardcoded: devnet has its
  // own start, and a re-seeded database would move it.
  const firstWritten = (n: Network) =>
    db
      .select({ at: sql<string | null>`min(${schema.events.createdAt})` })
      .from(schema.events)
      .where(eq(schema.events.network, n));
  const [mainnetStart, devnetStart] = await Promise.all([firstWritten("mainnet"), firstWritten("devnet")]);
  const startOf: Record<Network, string | null | undefined> = {
    mainnet: mainnetStart[0]?.at,
    devnet: devnetStart[0]?.at,
  };
  const recordStartOf = (n: Network): Date | null => (startOf[n] ? new Date(startOf[n]!) : null);
  const recordStart = recordStartOf(network);
  const recordStartsAt = recordStart ? recordStart.toISOString() : null;

  // Every count below the chart starts where the record does when the window
  // reaches back past it (90d+ windows): before the record start the only rows
  // are seeds and backfills, which would read as a trickle of "new deploys"
  // from years ago. The response says where they start (statsFrom), and the
  // page says so whenever that is not the window start.
  const statsClipped = recordStart != null && recordStart > windowStart;
  const start = statsClipped ? recordStart! : windowStart;
  const midMs = (start.getTime() + now) / 2;

  // event time = actual deploy time when we have it, else insert time (backfill).
  // Raw-SQL comparisons must bind an ISO string + ::timestamptz cast — the driver
  // only auto-encodes Date when drizzle knows the column type (not for coalesce()).
  const eventTime = sql`coalesce(${schema.events.blockTime}, ${schema.events.createdAt})`;
  const eventTimeGte = (d: Date) => sql`${eventTime} >= ${d.toISOString()}::timestamptz`;

  // programs active in the window, split into new deploys vs upgrades by the
  // per-program classification (deployType), so the funnel matches the radar.
  // The two halves are dated differently and cannot come from one scan: a new
  // deploy is dated by firstSeenAt, an upgrade by lastEventAt (the code change).
  // deployType is a lifetime flag, so counting upgrades off the firstSeenAt scan
  // only ever found programs On Record first met inside the window — the same
  // undercount that emptied the radar's upgrade tab.
  let deploys = 0;

  // Closed programs (ProgramData deallocated, rent reclaimed) are excluded from
  // the scan the same way the radar excludes them from its list — the header
  // total sits above that list and must count the same rows. They are not lost:
  // `churn.closed` below counts them on their own, and the radar keeps its
  // Closed section. Everything derived from this scan moves together, which is
  // what keeps churn.redeploys a share OF deploys rather than a number that can
  // exceed it.
  const live = sql`(${schema.subjects.facts} ->> 'closedAt') is null`;

  // new-program subjects in the window carry everything the breakdowns need.
  // Up to 30d each row brings its whole profile and facts — one read of each
  // stored blob, the fast path. Past 30d there are several times as many rows
  // and the whole blobs would not fit the API's 256 MB heap, so those windows
  // take only the keys read below (unpackedSubjects).
  const slim = windowHours > HOURLY_MAX_HOURS;
  const stages: Record<string, number> = {};
  let lapAt = Date.now();
  const lap = (label: string) => {
    stages[label] = Date.now() - lapAt;
    lapAt = Date.now();
  };

  let subs: SubjectLite[];
  let closedCount: number;
  const unpacked = slim
    ? await unpackedSubjects(network, start).catch((err) => {
        logger.warn({ err: String(err), network }, "funnel: unpacked read failed, reading key by key");
        return null;
      })
    : null;
  if (unpacked) {
    subs = unpacked.subs;
    closedCount = unpacked.closed;
  } else {
    subs = (await db
      .select({
        sha256: schema.subjects.sha256,
        noveltyBand: schema.subjects.noveltyBand,
        category: schema.subjects.category,
        name: schema.subjects.name,
        repoUrl: schema.subjects.repoUrl,
        authorityClass: schema.subjects.authorityClass,
        verified: schema.subjects.verified,
        idlPresent: schema.subjects.idlPresent,
        entityKey: schema.subjects.entityKey,
        deployerFundingSource: schema.subjects.deployerFundingSource,
        profile: slim ? slimProfile() : schema.subjects.profile,
        deployType: schema.subjects.deployType,
        firstSeenAt: schema.subjects.firstSeenAt,
        facts: slim ? slimFacts() : schema.subjects.facts,
      })
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.network, network),
          eq(schema.subjects.kind, "program"),
          gte(schema.subjects.firstSeenAt, start),
          live,
        ),
      )) as SubjectLite[];
    // the closed tail, counted on its own since the scan above excludes it
    const closedRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.network, network),
          eq(schema.subjects.kind, "program"),
          gte(schema.subjects.firstSeenAt, start),
          sql`(${schema.subjects.facts} ->> 'closedAt') is not null`,
        ),
      );
    closedCount = Number(closedRows[0]?.n ?? 0);
  }
  lap("newPrograms");

  // upgrades: every program whose code changed inside the window, however long
  // it has been on record. Dated by lastEventAt (falling back to firstSeenAt for
  // rows predating that column) — see the note above the deploy scan.
  // One row per upgraded program rather than a count: the sBPF panel needs each
  // one's version and when its code changed.
  const upgradeRows =
    (await unpackedUpgrades(network, start).catch((err) => {
      logger.warn({ err: String(err), network }, "funnel: unpacked upgrade read failed, reading key by key");
      return null;
    })) ?? (await upgradesKeyByKey(network, start, live));
  const upgrades = upgradeRows.length;
  lap("upgrades");

  const uniqueSha = new Set<string>();
  // binaries already counted toward byIntegration (see the loop below)
  const integrationSeen = new Set<string>();
  let novel = 0;
  let variants = 0;
  let clones = 0;
  const byCategory: Record<string, number> = {};
  const byFramework: Record<string, number> = Object.fromEntries(ALWAYS_LISTED.map((k) => [k, 0]));
  const byIntegration: Record<string, number> = {};
  const byCapability: Record<string, number> = {};
  const identity = { named: 0, withRepo: 0, opaque: 0 };
  const lineage = { novel: 0, variant: 0, fork: 0 };
  const control = { mutable: 0, frozen: 0, verified: 0 };
  const conviction = { knownEntity: 0, funderTraced: 0, untraced: 0 };
  // which machine compiled it (facts.buildMachine, from paths left in the bytes).
  // `unread` = no reading stored yet, kept apart from `unknown` = the binary
  // carries no machine paths.
  const buildMachine = { mac: 0, linux: 0, unknown: 0, unread: 0 };
  // churn / throwaway bots — a new deploy whose bytecode is a byte-clone of one
  // already on record (band=clone) is the same program redeployed under a fresh
  // id: the sniper-bot signature. `pumpfun` is the subset wired to Pump.fun;
  // `closed` is the tail that already reclaimed its rent.
  const churn = { redeploys: 0, pumpfun: 0, closed: closedCount };
  const fwEarly: Record<string, number> = {};
  const fwLate: Record<string, number> = {};
  let earlyTotal = 0;
  let lateTotal = 0;

  for (const s of subs) {
    if (s.sha256) uniqueSha.add(s.sha256);
    if (s.deployType !== "upgrade") deploys++;
    if (s.noveltyBand === "novel") {
      novel++;
      lineage.novel++;
    } else if (s.noveltyBand === "variant") {
      variants++;
      lineage.variant++;
    } else if (s.noveltyBand === "clone") {
      clones++;
      lineage.fork++;
    }

    const cat = s.category ?? "unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;

    const fw = frameworkKey(s);
    byFramework[fw] = (byFramework[fw] ?? 0) + 1;
    for (const cap of s.profile?.capabilities ?? []) byCapability[cap] = (byCapability[cap] ?? 0) + 1;
    // Integrations count DISTINCT BINARIES, not deploys. A sniper bot redeployed
    // 253x in a week would otherwise read as 253 programs "integrating" Pump.fun
    // — which is what made Pump.fun briefly outrank Token-2022 in the 7d panel.
    // Byte-identical code integrates nothing the original didn't. Rows with no
    // sha256 (unfingerprinted) still count individually rather than vanish.
    if (!s.sha256 || !integrationSeen.has(s.sha256)) {
      if (s.sha256) integrationSeen.add(s.sha256);
      for (const integ of s.profile?.integrations ?? [])
        byIntegration[integ] = (byIntegration[integ] ?? 0) + 1;
    }

    if (s.name) identity.named++;
    if (s.repoUrl) identity.withRepo++;
    if (!s.name && !s.repoUrl) identity.opaque++;

    if (s.authorityClass === "none") control.frozen++;
    else if (s.authorityClass) control.mutable++;
    if (s.verified) control.verified++;

    const bm = s.facts?.buildMachine;
    if (bm === "mac" || bm === "linux" || bm === "unknown") buildMachine[bm]++;
    else buildMachine.unread++;

    if (s.entityKey) conviction.knownEntity++;
    else if (s.deployerFundingSource) conviction.funderTraced++;
    else conviction.untraced++;

    // throwaway-bot signature: a new deploy that's a byte-clone of known code
    if (s.deployType !== "upgrade" && s.noveltyBand === "clone") {
      churn.redeploys++;
      if ((s.profile?.integrations ?? []).includes("Pump.fun")) churn.pumpfun++;
    }
    const t = s.firstSeenAt?.getTime() ?? 0;
    if (t >= midMs) {
      fwLate[fw] = (fwLate[fw] ?? 0) + 1;
      lateTotal++;
    } else {
      fwEarly[fw] = (fwEarly[fw] ?? 0) + 1;
      earlyTotal++;
    }
  }

  const frameworkTrend = Object.keys(byFramework)
    .map((framework) => {
      const earlyShare = earlyTotal ? (fwEarly[framework] ?? 0) / earlyTotal : 0;
      const lateShare = lateTotal ? (fwLate[framework] ?? 0) / lateTotal : 0;
      return {
        framework,
        current: byFramework[framework] ?? 0,
        earlyShare,
        lateShare,
        delta: lateShare - earlyShare,
      };
    })
    .sort((a, b) => b.current - a.current);

  // sBPF version of every program whose code changed in the window — new
  // deploys AND upgrades, the same 'new + upgrades' total as the page header,
  // since SIMD-0500 gates both. Each program counts once, at its current build.
  // A profile written before the field existed has no version: "not read".
  const sbpfOf = (v: number | null | undefined) =>
    v == null ? "not read" : v >= 0 && v <= 3 ? `v${v}` : "other";
  const sbpfEvents = [
    ...subs
      .filter((s) => s.deployType !== "upgrade")
      .map((s) => ({ key: sbpfOf(s.profile?.sbpfVersion), t: s.firstSeenAt?.getTime() ?? 0 })),
    ...upgradeRows.map((r) => ({ key: sbpfOf(r.sbpf), t: r.atMs })),
  ];
  const sbpfAll: Record<string, number> = {};
  const sbpfEarly: Record<string, number> = {};
  const sbpfLate: Record<string, number> = {};
  let sbpfEarlyTotal = 0;
  let sbpfLateTotal = 0;
  for (const e of sbpfEvents) {
    sbpfAll[e.key] = (sbpfAll[e.key] ?? 0) + 1;
    if (e.t >= midMs) {
      sbpfLate[e.key] = (sbpfLate[e.key] ?? 0) + 1;
      sbpfLateTotal++;
    } else {
      sbpfEarly[e.key] = (sbpfEarly[e.key] ?? 0) + 1;
      sbpfEarlyTotal++;
    }
  }
  const SBPF_ORDER = ["v3", "v2", "v1", "v0", "other", "not read"];
  const sbpfTrend = SBPF_ORDER.filter((k) => k.startsWith("v") || sbpfAll[k])
    .map((version) => {
      const earlyShare = sbpfEarlyTotal ? (sbpfEarly[version] ?? 0) / sbpfEarlyTotal : 0;
      const lateShare = sbpfLateTotal ? (sbpfLate[version] ?? 0) / sbpfLateTotal : 0;
      return { version, current: sbpfAll[version] ?? 0, earlyShare, lateShare, delta: lateShare - earlyShare };
    });

  // The three things a deployer publishes alongside the code: an IDL, a
  // security.txt (in the binary or the PMP account, as on the program page) and
  // a verified build. Same set as the sBPF panel: everything deployed or
  // upgraded in the window, each program once, as it stands now.
  const shipped = [
    ...subs
      .filter((s) => s.deployType !== "upgrade")
      .map((s) => ({ idl: s.idlPresent, sec: securityTxtSource(s.facts ?? {}) != null, verified: s.verified })),
    ...upgradeRows.map((r) => ({ idl: r.idlPresent, sec: securityTxtSource(r.sec ?? {}) != null, verified: r.verified })),
  ];
  const disclosure = {
    total: shipped.length,
    idl: shipped.filter((x) => x.idl).length,
    securityTxt: shipped.filter((x) => x.sec).length,
    verified: shipped.filter((x) => x.verified).length,
    allThree: shipped.filter((x) => x.idl && x.sec && x.verified).length,
  };

  lap("breakdowns");

  // Deploy/upgrade volume for the chart. Grouped BY NETWORK rather than
  // filtered to one: the chart plots mainnet and devnet side by side so the two
  // clusters' volumes are comparable at a glance, while every other panel on
  // the page stays scoped to `network`. One scan serves both.
  //   up to 30d: the 30-day hourly series, as before
  //   beyond:    one point per UTC day over the window, each cluster from its
  //              own record start — the backfilled rows before it are the
  //              undercount the chart marks, and on mainnet the archive below
  //              stands in for them
  const daily = windowHours > HOURLY_MAX_HOURS;
  const volStart = daily ? windowStart : new Date(now - 30 * 24 * HOUR);
  const bucket = daily
    ? sql<string>`to_char(date_trunc('day', ${eventTime} at time zone 'UTC'), 'YYYY-MM-DD"T00:00:00Z"')`
    : sql<string>`to_char(date_trunc('hour', ${eventTime}), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;
  const fromRecordStart = (n: Network) => {
    const at = recordStartOf(n);
    return at ? sql`(${schema.events.network} = ${n} and ${eventTimeGte(at)})` : sql`false`;
  };
  const volRows = await db
    .select({
      bucket,
      network: schema.events.network,
      n: sql<number>`count(*)`,
      deploys: sql<number>`count(*) filter (where ${schema.events.type} = 'deploy')`,
      upgrades: sql<number>`count(*) filter (where ${schema.events.type} = 'upgrade')`,
    })
    .from(schema.events)
    .where(
      and(
        inArray(schema.events.type, ["deploy", "upgrade"]),
        eventTimeGte(volStart),
        daily ? sql`(${fromRecordStart("mainnet")} or ${fromRecordStart("devnet")})` : undefined,
      ),
    )
    .groupBy(bucket, schema.events.network)
    .orderBy(bucket);
  lap("volume");
  const toPoint = (r: (typeof volRows)[number]) => ({
    t: Math.floor(new Date(r.bucket).getTime() / 1000),
    count: Number(r.n),
    deploys: Number(r.deploys),
    upgrades: Number(r.upgrades),
  });
  // `volume` keeps its meaning — this request's cluster — so nothing reading it
  // changes; `volumeByNetwork` is the explicit cross-cluster pair.
  const volume = volRows.filter((r) => r.network === network).map(toPoint);
  const volumeByNetwork = {
    mainnet: volRows.filter((r) => r.network === "mainnet").map(toPoint),
    devnet: volRows.filter((r) => r.network === "devnet").map(toPoint),
  };

  // Mainnet days before the record starts, from the Old Faithful archive: every
  // deploy and upgrade instruction the loaders executed, 2022-03-25 to the end
  // of its range. Counted the same way as the live events (one per instruction),
  // though the archive also sees programs deployed and closed between polls.
  // Only days strictly before the record-start day, so no day mixes the two.
  let archiveVolume: ApiFunnel["archiveVolume"];
  let archiveCoverage: ApiFunnel["archiveCoverage"] = null;
  if (daily && network === "mainnet" && recordStart) {
    const days = await loadHistoryStatsDaily();
    if (days && days.length > 0) {
      const firstDay = windowStart.toISOString().slice(0, 10);
      const seamDay = recordStart.toISOString().slice(0, 10);
      const byDay = new Map<string, { deploys: number; upgrades: number }>();
      let from = days[0]!.day;
      let to = days[0]!.day;
      for (const d of days) {
        if (d.day < from) from = d.day;
        if (d.day > to) to = d.day;
        if (d.day < firstDay || d.day >= seamDay) continue;
        const cur = byDay.get(d.day) ?? { deploys: 0, upgrades: 0 };
        cur.deploys += d.deploys;
        cur.upgrades += d.upgrades;
        byDay.set(d.day, cur);
      }
      archiveCoverage = { from, to };
      archiveVolume = [...byDay.entries()]
        .sort((x, y) => (x[0] < y[0] ? -1 : 1))
        .map(([day, v]) => ({
          t: Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000),
          count: v.deploys + v.upgrades,
          deploys: v.deploys,
          upgrades: v.upgrades,
        }));
    }
  }

  lap("archive");
  logger.info({ network, windowHours, slim, unpacked: unpacked != null, ...stages }, "funnel: stages");

  const raw = deploys + upgrades;

  return {
    date: todayKey(),
    raw,
    unique: uniqueSha.size,
    novel,
    clones,
    variants,
    deploys,
    upgrades,
    windowHours,
    aggregateWindowHours: windowHours,
    capped: false,
    byCategory,
    byFramework,
    byIntegration,
    byCapability,
    buildMachine,
    volume,
    volumeByNetwork,
    volumeBucket: daily ? "day" : "hour",
    recordStartsAt,
    recordStartsAtByNetwork: {
      mainnet: recordStartOf("mainnet")?.toISOString() ?? null,
      devnet: recordStartOf("devnet")?.toISOString() ?? null,
    },
    statsFrom: start.toISOString(),
    statsClipped,
    archiveVolume,
    archiveCoverage,
    identity,
    lineage,
    control,
    conviction,
    churn,
    frameworkTrend,
    sbpfTrend,
    disclosure,
    updatedAt: new Date().toISOString(),
  };
}

/** Cron helper: persist a compact daily record to funnel_daily (historical trail).
 *  The live API uses computeWindowFunnel; this is just the append-only record. */
export async function snapshotFunnel(date: string, network: Network = "mainnet"): Promise<void> {
  const { start, end } = dayBounds(date);
  const upper = date === todayKey() ? new Date() : end;
  const eventTime = sql`coalesce(${schema.events.blockTime}, ${schema.events.createdAt})`;

  const rawRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
        sql`${eventTime} >= ${start.toISOString()}::timestamptz`,
        sql`${eventTime} < ${upper.toISOString()}::timestamptz`,
      ),
    );
  const raw = Number(rawRows[0]?.n ?? 0);

  const subs = await db
    .select({
      sha256: schema.subjects.sha256,
      band: schema.subjects.noveltyBand,
      category: schema.subjects.category,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, start),
        lt(schema.subjects.firstSeenAt, upper),
      ),
    );

  const uniqueSha = new Set<string>();
  let clones = 0;
  let variants = 0;
  let novel = 0;
  const byCategory: Record<string, number> = {};
  for (const s of subs) {
    if (s.sha256) uniqueSha.add(s.sha256);
    if (s.band === "clone") clones++;
    else if (s.band === "variant") variants++;
    else if (s.band === "novel") {
      novel++;
      const cat = s.category ?? "unknown";
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }
  }

  await db
    .insert(schema.funnelDaily)
    .values({ date, network, raw, unique: uniqueSha.size, novel, clones, variants, byCategory, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.funnelDaily.date, schema.funnelDaily.network],
      set: { raw, unique: uniqueSha.size, novel, clones, variants, byCategory, updatedAt: new Date() },
    });
}

function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

// ---------------------------------------------------------------------------
// Reading only the keys the stats need out of profile and facts. Each stored
// blob is compressed, and Postgres decompresses it again for every `->` that
// touches it: six keys from facts meant six decompressions of the same value
// per row, which is most of what made the 90d+ counts take minutes.
// jsonb_to_record unpacks each blob once and hands back all the keys.
// A JSON null comes back as SQL null, the same as `->>` gave the filters.
// ---------------------------------------------------------------------------

type UnpackedRow = {
  sha256: string | null;
  novelty_band: string | null;
  category: string | null;
  name: string | null;
  repo_url: string | null;
  authority_class: string | null;
  verified: boolean;
  idl_present: boolean;
  entity_key: string | null;
  deployer_funding_source: string | null;
  deploy_type: string | null;
  first_seen_ms: number | null;
  has_profile: boolean;
  framework: unknown;
  anchor_line: unknown;
  integrations: unknown;
  capabilities: unknown;
  sbpf: unknown;
  closed: boolean;
  source_framework: unknown;
  build_machine: unknown;
  has_security_txt: unknown;
  security_txt: unknown;
  pmp_security: unknown;
};

/** New programs since `start`, closed ones included and counted apart. */
async function unpackedSubjects(network: Network, start: Date): Promise<{ subs: SubjectLite[]; closed: number }> {
  const rows = (await db.execute(sql`
    select s.sha256, s.novelty_band, s.category, s.name, s.repo_url, s.authority_class,
      s.verified, s.idl_present, s.entity_key, s.deployer_funding_source, s.deploy_type,
      (extract(epoch from s.first_seen_at) * 1000)::float8 as first_seen_ms,
      s.profile is not null as has_profile,
      p.framework, p.anchor -> 'line' as anchor_line, p.integrations, p.capabilities,
      p."sbpfVersion" as sbpf,
      f."closedAt" is not null as closed,
      f."sourceFramework" as source_framework, f."buildMachine" as build_machine,
      f."hasSecurityTxt" as has_security_txt, f."securityTxt" as security_txt,
      f."pmpSecurity" as pmp_security
    from subjects s
    left join lateral jsonb_to_record(s.profile) as p(
      framework jsonb, anchor jsonb, integrations jsonb, capabilities jsonb, "sbpfVersion" jsonb
    ) on true
    left join lateral jsonb_to_record(s.facts) as f(
      "closedAt" jsonb, "sourceFramework" jsonb, "buildMachine" jsonb,
      "hasSecurityTxt" jsonb, "securityTxt" jsonb, "pmpSecurity" jsonb
    ) on true
    where s.network = ${network} and s.kind = 'program'
      and s.first_seen_at >= ${start.toISOString()}::timestamptz
  `)) as unknown as UnpackedRow[];
  let closed = 0;
  const subs: SubjectLite[] = [];
  for (const r of rows) {
    if (r.closed) {
      closed++;
      continue;
    }
    subs.push({
      sha256: r.sha256,
      noveltyBand: r.novelty_band,
      category: r.category,
      name: r.name,
      repoUrl: r.repo_url,
      authorityClass: r.authority_class,
      verified: r.verified,
      idlPresent: r.idl_present,
      entityKey: r.entity_key,
      deployerFundingSource: r.deployer_funding_source,
      deployType: r.deploy_type,
      firstSeenAt: r.first_seen_ms == null ? null : new Date(r.first_seen_ms),
      profile: r.has_profile
        ? ({
            framework: r.framework,
            anchor: { line: r.anchor_line },
            integrations: r.integrations,
            capabilities: r.capabilities,
            sbpfVersion: r.sbpf,
          } as unknown as ProgramProfile)
        : null,
      facts: {
        sourceFramework: r.source_framework,
        buildMachine: r.build_machine,
        hasSecurityTxt: r.has_security_txt,
        securityTxt: r.security_txt,
        pmpSecurity: r.pmp_security,
      },
    });
  }
  return { subs, closed };
}

type UpgradeRow = {
  atMs: number;
  sbpf: number | null;
  verified: boolean;
  idlPresent: boolean;
  sec: { hasSecurityTxt?: boolean; securityTxt?: unknown; pmpSecurity?: unknown };
};

/** Live programs whose code changed since `start`, facts unpacked once. */
async function unpackedUpgrades(network: Network, start: Date): Promise<UpgradeRow[]> {
  const rows = (await db.execute(sql`
    select (extract(epoch from coalesce(s.last_event_at, s.first_seen_at)) * 1000)::float8 as at_ms,
      (s.profile ->> 'sbpfVersion')::int as sbpf, s.verified, s.idl_present,
      f."hasSecurityTxt" as has_security_txt, f."securityTxt" as security_txt,
      f."pmpSecurity" as pmp_security
    from subjects s
    left join lateral jsonb_to_record(s.facts) as f(
      "closedAt" jsonb, "hasSecurityTxt" jsonb, "securityTxt" jsonb, "pmpSecurity" jsonb
    ) on true
    where s.network = ${network} and s.kind = 'program' and s.deploy_type = 'upgrade'
      and coalesce(s.last_event_at, s.first_seen_at) >= ${start.toISOString()}::timestamptz
      and f."closedAt" is null
  `)) as unknown as {
    at_ms: number;
    sbpf: number | null;
    verified: boolean;
    idl_present: boolean;
    has_security_txt: boolean | undefined;
    security_txt: unknown;
    pmp_security: unknown;
  }[];
  return rows.map((r) => ({
    atMs: r.at_ms,
    sbpf: r.sbpf,
    verified: r.verified,
    idlPresent: r.idl_present,
    sec: { hasSecurityTxt: r.has_security_txt, securityTxt: r.security_txt, pmpSecurity: r.pmp_security },
  }));
}

// The earlier per-key reads, kept as the fallback should a stored blob ever
// not be a JSON object (jsonb_to_record refuses those).

function slimProfile() {
  return sql<ProgramProfile | null>`case when ${schema.subjects.profile} is null then null else jsonb_build_object(
    'framework', ${schema.subjects.profile} -> 'framework',
    'anchor', jsonb_build_object('line', ${schema.subjects.profile} -> 'anchor' -> 'line'),
    'integrations', ${schema.subjects.profile} -> 'integrations',
    'capabilities', ${schema.subjects.profile} -> 'capabilities',
    'sbpfVersion', ${schema.subjects.profile} -> 'sbpfVersion') end`;
}

function slimFacts() {
  return sql<Record<string, unknown> | null>`case when ${schema.subjects.facts} is null then null else jsonb_build_object(
    'sourceFramework', ${schema.subjects.facts} -> 'sourceFramework',
    'buildMachine', ${schema.subjects.facts} -> 'buildMachine',
    'hasSecurityTxt', ${schema.subjects.facts} -> 'hasSecurityTxt',
    'securityTxt', ${schema.subjects.facts} -> 'securityTxt',
    'pmpSecurity', ${schema.subjects.facts} -> 'pmpSecurity') end`;
}

async function upgradesKeyByKey(network: Network, start: Date, live: SQL): Promise<UpgradeRow[]> {
  const rows = await db
    .select({
      at: sql<string>`coalesce(${schema.subjects.lastEventAt}, ${schema.subjects.firstSeenAt})`,
      sbpf: sql<number | null>`(${schema.subjects.profile} ->> 'sbpfVersion')::int`,
      verified: schema.subjects.verified,
      idlPresent: schema.subjects.idlPresent,
      sec: sql<UpgradeRow["sec"]>`jsonb_build_object(
        'hasSecurityTxt', ${schema.subjects.facts} -> 'hasSecurityTxt',
        'securityTxt', ${schema.subjects.facts} -> 'securityTxt',
        'pmpSecurity', ${schema.subjects.facts} -> 'pmpSecurity')`,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.deployType, "upgrade"),
        sql`coalesce(${schema.subjects.lastEventAt}, ${schema.subjects.firstSeenAt}) >= ${start.toISOString()}::timestamptz`,
        live,
      ),
    );
  return rows.map((r) => ({ ...r, atMs: new Date(r.at).getTime() }));
}
