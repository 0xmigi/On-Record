import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { SectionHeader } from "@/components/SectionHeader";
import { FlowChart } from "@/components/FlowChart";
import { WindowPicker } from "@/components/WindowPicker";
import type { VersionNet, VersionRow } from "@/components/VersionCompare";
import { CardFoot, CardHead, HasKey, MeterList, SplitRows, TallSplit, type MeterRow } from "@/components/StatBits";
import { ToolchainView } from "@/components/ToolchainView";
import { OpennessView } from "@/components/OpennessView";
import { LifecycleView } from "@/components/LifecycleView";
import { ARCHIVE_FROM, categoryLabel, fetchFunnel, fetchRadar, type ApiFunnel, type RadarWindow } from "@/lib/api";
import { mergeFunnels, type StatsFunnel } from "@/lib/funnel-merge";
import { groupNum, truncateAddress, utcStamp } from "@/lib/format";
import { buildRadarHref, STATS_FRAMEWORK_FACET, type NetworkFilter, type RadarParams } from "@/lib/radar-url";

const WINDOW_KEYS = ["24h", "48h", "7d", "30d", "90d", "1y", "all"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];
/** Windows that reach back past the live record. They need an API that says
 *  where its counts start (statsFrom); an older build would answer 90d/1y with
 *  48h and "all" with every seeded program, so the page refuses to read them. */
const LONG_WINDOWS: readonly WindowKey[] = ["90d", "1y", "all"];
/** Devnet has no archive, so its 1y would be the same months as "all". */
const DEVNET_WINDOWS: readonly WindowKey[] = ["24h", "48h", "7d", "30d", "90d", "all"];
const WINDOW_SECS: Record<Exclude<WindowKey, "all">, number> = {
  "24h": 86_400,
  "48h": 172_800,
  "7d": 604_800,
  "30d": 2_592_000,
  "90d": 7_776_000,
  "1y": 31_536_000,
};

// each stats window → the radar window covering the same trailing hours.
// None covers 90d or 1y, and the radar's "all" includes programs seeded from
// before the record, so long windows link nowhere rather than to a list that
// disagrees with the figure.
const RADAR_WINDOW: Partial<Record<WindowKey, RadarWindow>> = {
  "24h": "today",
  "48h": "48h",
  "7d": "week",
  "30d": "month",
};

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const metadata: Metadata = {
  title: "Program Stats",
  description: "Stats on every program deployed to Solana, over a time window.",
};


function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** A labelled group of panels: one kind of measure. */
function StatSection({ title, columns = 2, children }: { title: string; columns?: 2 | 3; children: React.ReactNode }) {
  return (
    <section className="stats-section">
      <h2 className="stats-section-title">{title}</h2>
      <div className={`stat-grid${columns === 3 ? " stat-grid-3" : ""}`}>{children}</div>
    </section>
  );
}

/** sBPF versions are ordered, so one hue from light (v0) to dark (v3). */
const SBPF_SHADE: Record<string, string> = {
  v0: "var(--viz-1)",
  v1: "var(--viz-2)",
  v2: "var(--viz-3)",
  v3: "var(--viz-4)",
};

/** Ordered buckets as "within" rows: each the share of the whole that falls
 *  at or under that edge. The last bucket (beyond every edge) gets no row. */
function cumulative(buckets: number[], edges: string[]): MeterRow[] {
  const n = buckets.reduce((a, b) => a + b, 0);
  let run = 0;
  return edges.map((label, i) => {
    run += buckets[i] ?? 0;
    return { label, value: `${pct(run, n)}%`, frac: n ? run / n : 0 };
  });
}

/** seconds as the coarsest unit that reads well */
function fmtDuration(s: number): string {
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) {
    const h = Math.round(s / 3_600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"}`;
}


const sharePp = (x: number) => Math.round(x * 100);

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; network?: string }>;
}) {
  const sp = await searchParams;
  let win: WindowKey = (WINDOW_KEYS as readonly string[]).includes(sp.window ?? "")
    ? (sp.window as WindowKey)
    : "48h";
  // The page follows the site's network switch (the `cluster` cookie the
  // toggle writes; an explicit ?network= wins), default all networks, like the
  // radar. The API counts each network on its own, so "all" fetches both and
  // adds them up (funnel-merge.ts).
  const cookieNetwork = (await cookies()).get("cluster")?.value;
  const pick = (v: string | undefined): NetworkFilter | null =>
    v === "all" || v === "mainnet" || v === "devnet" ? v : null;
  const network: NetworkFilter = pick(sp.network) ?? pick(cookieNetwork) ?? "all";
  const windows = network === "devnet" ? DEVNET_WINDOWS : WINDOW_KEYS;
  if (!windows.includes(win)) win = "all";
  const usable = (f: ApiFunnel | null) => (f && (!LONG_WINDOWS.includes(win) || f.statsFrom) ? f : null);
  let funnel: StatsFunnel | null;
  // on all networks, each network's own funnel too, for the cards that compare
  let pair: { mainnet: ApiFunnel; devnet: ApiFunnel } | null = null;
  if (network === "all") {
    // devnet has no 1y (no archive, so it is the same months as "all")
    const [main, dev] = await Promise.all([
      fetchFunnel(win, "mainnet"),
      fetchFunnel(win === "1y" ? "all" : win, "devnet"),
    ]);
    const m = usable(main);
    const d = usable(dev);
    funnel = m && d ? mergeFunnels(m, d) : m;
    if (m && d) pair = { mainnet: m, devnet: d };
  } else {
    funnel = usable(await fetchFunnel(win, network));
  }

  const windowNav = (
    <WindowPicker
      key="window-picker"
      active={win}
      options={windows.map((k) => ({
        key: k,
        href: `/funnel?window=${k}${sp.network ? `&network=${network}` : ""}`,
      }))}
    />
  );

  if (!funnel) {
    return (
      <>
        <h1 className="funnel-title">Program Stats</h1>
        {windowNav}
        <div className="empty-state" style={{ marginTop: 24 }}>
          <Mark size={22} />
          <p className="empty-title">No data</p>
          <p className="empty-body">No programs analyzed for this window yet.</p>
        </div>
      </>
    );
  }

  const raw = funnel.raw;
  // the chart's span: "all" runs from the archive's first day (mainnet) or the
  // record start (devnet) to now
  const chartFrom = win === "all" ? (funnel.archiveCoverage?.from ?? funnel.statsFrom ?? null) : null;
  const windowSecs =
    win === "all"
      ? Math.max(86_400, Math.round((Date.now() - (chartFrom ? Date.parse(chartFrom) : Date.now())) / 1000))
      : WINDOW_SECS[win];
  const sorted = (m?: Record<string, number>): [string, number][] =>
    Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);

  // A figure links to the radar view that lists the same slice: new deploys,
  // this window, this cluster, narrowed by the one facet the figure counts.
  const radarBase: RadarParams = {
    type: "deploy",
    window: RADAR_WINDOW[win] ?? "all",
    network,
    verification: null,
    sectxt: false,
    idl: false,
    repo: false,
    active: false,
    authority: null,
    category: null,
    framework: null,
    size: null,
    sbpf: null,
  };
  const radar = (patch: Partial<RadarParams>): string | undefined =>
    RADAR_WINDOW[win] ? buildRadarHref({ ...radarBase, ...patch }) : undefined;

  // the window's novel programs themselves: a handful of names says more than
  // a bar. Only where the radar has the same window, so the list and the count
  // describe the same programs.
  const novelPage = RADAR_WINDOW[win]
    ? await fetchRadar({ type: "deploy", window: RADAR_WINDOW[win], band: "novel", network, limit: 6, sort: "interest" })
    : null;

  // frameworks → one composition bar; each framework's v3 share rides along
  const fwTrend = funnel.frameworkTrend?.filter((t) => t.current > 0) ?? [];
  const fwTotal = fwTrend.reduce((a, t) => a + t.current, 0);
  const fwV3 = new Map((funnel.sbpfByFramework ?? []).filter((f) => f.read > 0).map((f) => [f.framework, f]));

  // sBPF: the share on v3, of the programs whose version was read
  const v0Upgrades = funnel.sbpfUpgrades?.v0 ?? 0;
  // Lifecycle figures for one funnel; on all networks each is a pair,
  // mainnet's with devnet's line under it
  const lifeOf = (f: ApiFunnel | StatsFunnel) => {
    const lc = f.lifecycle;
    return {
      closedWithin:
        lc && lc.lifespan.n > 0 ? cumulative(lc.lifespan.buckets, ["1 hour", "1 day", "1 week", "30 days"]) : null,
      medianLife: lc?.lifespan.median != null ? fmtDuration(lc.lifespan.median) : null,
      upgradeWithin:
        lc && lc.upgradeGap.n > 0 ? cumulative(lc.upgradeGap.buckets, ["1 day", "1 week", "30 days", "90 days"]) : null,
      medianGap: lc?.upgradeGap.median != null ? fmtDuration(lc.upgradeGap.median) : null,
      clones: f.churn
        ? [
            {
              label: "identical to known code",
              value: `${pct(f.churn.redeploys, f.deploys)}% · ${groupNum(f.churn.redeploys)}`,
              frac: f.deploys ? f.churn.redeploys / f.deploys : 0,
              href: radar({ view: "recycled" }),
            },
            {
              label: "Pump.fun clones",
              value: `${pct(f.churn.pumpfun, f.deploys)}% · ${groupNum(f.churn.pumpfun)}`,
              frac: f.deploys ? f.churn.pumpfun / f.deploys : 0,
            },
          ]
        : null,
    };
  };
  type Life = ReturnType<typeof lifeOf>;
  /** rows for one figure: alone, or mainnet's with devnet's under each */
  const pairUp = (of: typeof lifeOf, k: "closedWithin" | "upgradeWithin" | "clones"): MeterRow[] | null => {
    if (!pair) return of(funnel)[k];
    const m = of(pair.mainnet)[k];
    const d = of(pair.devnet)[k];
    if (!m && !d) return null;
    const base = m ?? d!.map((r) => ({ ...r, value: "–", frac: 0 }));
    return base.map((r, i) => ({ ...r, dev: d?.[i] ? { value: d[i]!.value, frac: d[i]!.frac } : { value: "–", frac: 0 } }));
  };
  const pairFig = (of: typeof lifeOf, k: "medianGap"): { main: string; dev: string | null } | null => {
    if (!pair) {
      const v = (of(funnel) as Life)[k];
      return v ? { main: v, dev: null } : null;
    }
    const m = of(pair.mainnet)[k];
    const d = of(pair.devnet)[k];
    return m || d ? { main: m ?? "–", dev: d ?? "–" } : null;
  };

  // sBPF per version: on all networks a bar per network, else the one
  const versionNet = (f: ApiFunnel, net: VersionNet["net"], version: string): VersionNet => {
    const rows = f.sbpfTrend ?? [];
    const read = rows.filter((t) => t.version !== "not read" && t.version !== "other").reduce((a, t) => a + t.current, 0);
    const t = rows.find((r) => r.version === version);
    return {
      net,
      n: t?.current ?? 0,
      share: read ? ((t?.current ?? 0) / read) * 100 : 0,
      early: t?.earlyShare != null && t.lateShare != null ? t.earlyShare * 100 : null,
      late: t?.earlyShare != null && t.lateShare != null ? t.lateShare * 100 : null,
    };
  };
  const sbpfVersions: VersionRow[] = ["v3", "v2", "v1", "v0"].map((version) => ({
    version,
    nets: pair
      ? [versionNet(pair.mainnet, "mainnet", version), versionNet(pair.devnet, "devnet", version)]
      : [versionNet(funnel as ApiFunnel, null, version)],
  }));

  return (
    // devnet alone is hatched too: hatched always means devnet on this page
    <div className={network === "devnet" ? "stats-devnet" : undefined}>
      <h1 className="funnel-title">Program Stats</h1>

      <div className="stream-status">
        {/* the whole page is the network chosen in the site's settings, so it
            needs no label here. The totals live on the chart, as its series
            switch; without a chart they stay here */}
        {!funnel.volume?.length ? (
          <>
            <span>{groupNum(raw)} programs</span>
            <span className="stream-sep">·</span>
            <span>
              {groupNum(funnel.deploys)} new · {groupNum(funnel.upgrades)} upgrades
            </span>
          </>
        ) : null}
        {funnel.capped ? (
          <>
            <span className="stream-sep">·</span>
            <span className="stream-cap">stats capped at 48h · chart shows {win}</span>
          </>
        ) : null}
        {/* time frames at the right end of the same line, above the chart */}
        <span className="stream-status-end">{windowNav}</span>
      </div>

      {funnel.volume && funnel.volume.length > 0 ? (
        <section className="stat-card stat-card-wide">
          <SectionHeader
            title="Deploys over time"
            info={`New deploys and upgrades, stacked, per time bucket. Like the rest of the page, it shows the network picked in settings; on all networks, mainnet is solid and devnet hatched, on one scale. The time frames drive the whole page. Older buckets undercount — the loader only stores each program's last deploy slot. On 90d and longer: one bar per day or week, and on mainnet the bars before the record starts come from the Old Faithful archive, every deploy and upgrade instruction since ${ARCHIVE_FROM}.`}
          />
          <FlowChart
            volume={funnel.volume}
            networkLabel={network === "all" ? "mainnet" : network}
            devnetVolume={network === "all" ? funnel.volumeByNetwork?.devnet : undefined}
            devnetStartsAt={network === "all" ? funnel.recordStartsAtByNetwork?.devnet : undefined}
            recordStartsAt={funnel.recordStartsAt}
            archiveVolume={funnel.archiveVolume}
            windowSecs={windowSecs}
            figures={{
              programs: raw,
              deploys: funnel.deploys,
              upgrades: funnel.upgrades,
              // the window reaches back past the live record: say where the
              // counts actually start, so a 1y figure is never read as a year
              since: funnel.statsClipped ? funnel.statsFrom : null,
              sinceTip: `On Record's ${network === "all" ? "mainnet" : network} record starts ${funnel.statsFrom ? dayLabel(funnel.statsFrom) : ""}. These counts and every panel below the chart start there.${
                funnel.archiveVolume?.length ? " The chart before it is the Old Faithful archive." : ""
              }`,
            }}
          />
        </section>
      ) : null}

      {/* Sections in order of what people look for: toolchain, then openness;
          the rest at the bottom. Every panel follows the site's network switch. */}
      <StatSection title="Toolchain">
        {fwTrend.length > 0 ? (
          <ToolchainView
            frameworks={fwTrend.map((t) => ({
              key: t.framework,
              share: fwTotal ? (t.current / fwTotal) * 100 : 0,
              n: t.current,
              // combined networks carry no half-by-half shares
              change:
                funnel.combined || Math.abs(sharePp(t.delta)) <= 2
                  ? undefined
                  : `${t.delta > 0 ? "↑" : "↓"} ${Math.abs(sharePp(t.delta))}pp over the window`,
            }))}
            frameworksInfo="Framework of each new deploy, as a share of the new deploys in each period. Before the record starts the counts come from the Old Faithful archive (mainnet only), which names Anchor, native and Pinocchio but does not split out Anchor v2 or Quasar. From the record start, Anchor v2 is counted apart from earlier Anchor, and Quasar is named from the program's source, since its binary reads as Pinocchio. Click a band to narrow the section to it."
            series={
              (funnel.frameworkSeries?.points.length ?? 0) >= 2
                ? {
                    ...funnel.frameworkSeries!,
                    archiveLabel: network === "all" ? "archive · mainnet only" : "archive",
                  }
                : null
            }
            integrations={sorted(funnel.byIntegration)}
            sbpf={sbpfVersions}
            sbpfInfo="The sBPF version each program's bytecode targets, read from its ELF header. New deploys and upgrades together, each program once at its current build, of the ones whose version was read. SIMD-0500 makes v3 the only version accepted for deploys and upgrades. Each figure is the share in the window's first half → its second half, left out when either half is under 90% read. On all networks, mainnet and devnet are shown apart (devnet hatched)."
            machine={(funnel.buildSetup?.machine ?? []).map((r) => ({ key: r.version, total: r.total, verified: r.verified }))}
            machineInfo="Machine that compiled each program, read from paths the compiler left in its bytes, and the share of those with a verified build. A Mac build can't byte-match the Linux/Docker rebuild a verification uses. Unknown: no machine paths left in the binary. New deploys and upgrades, each program once."
            v0Upgrades={v0Upgrades}
            v0Href={radar({ type: "upgrade", sbpf: "v0" })}
            byFramework={funnel.toolchainByFramework}
            machineDev={
              pair
                ? {
                    mainnet: (pair.mainnet.buildSetup?.machine ?? []).map((r) => ({ key: r.version, total: r.total, verified: r.verified })),
                    devnet: (pair.devnet.buildSetup?.machine ?? []).map((r) => ({ key: r.version, total: r.total, verified: r.verified })),
                  }
                : null
            }
            v0Dev={pair ? { mainnet: pair.mainnet.sbpfUpgrades?.v0 ?? 0, devnet: pair.devnet.sbpfUpgrades?.v0 ?? 0 } : null}
            byFrameworkNet={
              pair ? { mainnet: pair.mainnet.toolchainByFramework, devnet: pair.devnet.toolchainByFramework } : null
            }
          />
        ) : null}

      </StatSection>

      <StatSection title="Openness">
        {funnel.authority && funnel.disclosure && funnel.disclosure.total > 0 ? (
          <OpennessView
            authority={funnel.authority}
            authorityInfo="Who can change the code, over the window's deploys and upgrades. Pick a kind to narrow Published and Verified builds to it. Immutable: no upgrade authority, the code can never change. Multisig: a Squads multisig holds it. Program: another program (a PDA, such as a governance program) holds it. Single key: one wallet can replace the code. Not read: no authority reading stored yet."
            disclosure={funnel.disclosure}
            byAuthority={funnel.disclosureByAuthority}
            publishedInfo="Share of the window's deploys and upgrades that publish each one, every program once as it stands now. IDL: found when the program was deployed (Anchor IDL account or Program Metadata). security.txt: in the binary or the Program Metadata account. Source repo: a repository found in the binary or a verified build."
            verifiedInfo="Verified build: the deployed bytes match a rebuild from public source (OtterSec). Same programs as Published. Lost verification: programs whose verified build an upgrade replaced inside the window, not verified again since."
            lostVerification={funnel.lostVerification}
            lostHref={radar({ verification: "lost" })}
            byNet={
              pair && pair.mainnet.authority && pair.devnet.authority && pair.mainnet.disclosure && pair.devnet.disclosure
                ? {
                    mainnet: {
                      authority: pair.mainnet.authority,
                      disclosure: pair.mainnet.disclosure,
                      byAuthority: pair.mainnet.disclosureByAuthority,
                      lostVerification: pair.mainnet.lostVerification,
                    },
                    devnet: {
                      authority: pair.devnet.authority,
                      disclosure: pair.devnet.disclosure,
                      byAuthority: pair.devnet.disclosureByAuthority,
                      lostVerification: pair.devnet.lostVerification,
                    },
                  }
                : null
            }
          />
        ) : null}
      </StatSection>

      {funnel.lifecycle ? (
        <StatSection title="Lifecycle">
          <section className="stat-card stat-span">
            <LifecycleView
              windowLabel={`${network === "all" ? "on mainnet " : ""}${win === "all" ? "since the record began" : `in the last ${win}`}`}
              // closures are swept on mainnet only (closed.ts), so devnet has
              // no live/closed split to show; on all networks it is mainnet's
              showSplit={network !== "devnet"}
              live={(pair ? pair.mainnet : funnel).lifecycle?.live ?? 0}
              closed={(pair ? pair.mainnet : funnel).lifecycle?.closed ?? 0}
              closedWithin={pair ? lifeOf(pair.mainnet).closedWithin : lifeOf(funnel).closedWithin}
              medianLife={
                (pair ? lifeOf(pair.mainnet) : lifeOf(funnel)).medianLife
                  ? { main: (pair ? lifeOf(pair.mainnet) : lifeOf(funnel)).medianLife!, dev: null }
                  : null
              }
              upgradeWithin={pairUp(lifeOf, "upgradeWithin")}
              medianGap={pairFig(lifeOf, "medianGap")}
              upgradeInfo={`Live programs upgraded in the window: how soon each upgrade came after the program's previous code change on record. ${groupNum(funnel.lifecycle.upgradeGap.noEarlier)} more had their previous change before On Record's record began, so there is no gap to measure.`}
              clones={pairUp(lifeOf, "clones")}
            />
          </section>
        </StatSection>
      ) : null}

      <p className="funnel-updated">last {win} · updated {utcStamp(funnel.updatedAt)}</p>
    </div>
  );
}
