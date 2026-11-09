import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { SectionHeader } from "@/components/SectionHeader";
import { FlowChart } from "@/components/FlowChart";
import { BotExplainer } from "@/components/BotExplainer";
import { ARCHIVE_FROM, categoryLabel, fetchFunnel, type Category, type Network, type RadarWindow } from "@/lib/api";
import { groupNum, utcStamp } from "@/lib/format";
import { buildRadarHref, STATS_FRAMEWORK_FACET, type RadarParams } from "@/lib/radar-url";

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

const CATEGORY_ORDER: Category[] = [
  "dex",
  "staking",
  "launchpad",
  "lending",
  "perps",
  "bridge",
  "oracle",
  "nft",
  "governance",
  "airdrop",
  "token",
  "infra",
  "defi",
  "unknown",
];

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

// each row is [label, count, optional hover definition, optional radar link]
type BreakdownRow = [string, number, string?, string?];

function Breakdown({
  rows,
  labelWidth = 116,
}: {
  rows: BreakdownRow[];
  labelWidth?: number;
}) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="cat-breakdown">
      {rows.map(([label, n, tip, href]) => {
        const body = (
          <>
            <span
              className={`cat-chip${tip ? " has-tip" : ""}`}
              style={{ minWidth: labelWidth, textAlign: "left" }}
            >
              {label}
              {tip ? <span className="tip-pop">{tip}</span> : null}
            </span>
            <div className="cat-bar-track">
              <div className="cat-bar" style={{ width: `${pct(n, max)}%` }} />
            </div>
            <span className="cat-bar-num">{n}</span>
          </>
        );
        return href ? (
          <Link className="cat-bar-row is-link" href={href} key={label}>
            {body}
          </Link>
        ) : (
          <div className="cat-bar-row" key={label}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; network?: string }>;
}) {
  const sp = await searchParams;
  let win: WindowKey = (WINDOW_KEYS as readonly string[]).includes(sp.window ?? "")
    ? (sp.window as WindowKey)
    : "48h";
  // Cluster is sticky the same way the radar's is: explicit ?network= wins, else
  // the cookie the toggle persists, else mainnet. This page used to call
  // fetchFunnel(win) with no network at all, so every panel — volume chart
  // included — silently reported mainnet even with the app toggled to devnet.
  const cookieNetwork = (await cookies()).get("network")?.value;
  const network: Network =
    sp.network === "devnet"
      ? "devnet"
      : sp.network === "mainnet"
        ? "mainnet"
        : cookieNetwork === "devnet"
          ? "devnet"
          : "mainnet";
  const windows = network === "devnet" ? DEVNET_WINDOWS : WINDOW_KEYS;
  if (!windows.includes(win)) win = "all";
  const fetched = await fetchFunnel(win, network);
  const funnel = fetched && (!LONG_WINDOWS.includes(win) || fetched.statsFrom) ? fetched : null;

  const windowNav = (
    <nav className="chart-windows" aria-label="Time window">
      {windows.map((k) => (
        <Link
          key={k}
          href={`/funnel?window=${k}${network === "devnet" ? "&network=devnet" : ""}`}
          className={`chart-win-btn${win === k ? " active" : ""}`}
          aria-current={win === k ? "page" : undefined}
        >
          {k}
        </Link>
      ))}
    </nav>
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
  };
  const radar = (patch: Partial<RadarParams>): string | undefined =>
    RADAR_WINDOW[win] ? buildRadarHref({ ...radarBase, ...patch }) : undefined;

  return (
    <>
      <h1 className="funnel-title">Program Stats</h1>

      {windowNav}

      <div className="stream-status">
        <span className="stream-dot" aria-hidden="true" />
        {/* every panel here is one cluster's data — say which, so the numbers
            are never read as a mainnet+devnet total */}
        <span className="stream-status-strong">{network}</span>
        <span className="stream-sep">·</span>
        <span className="stream-status-strong">{win === "all" ? "all" : `last ${win}`}</span>
        {/* the window reaches back past the live record: say where the counts
            actually start, so a 1y figure is never read as a year */}
        {funnel.statsClipped && funnel.statsFrom ? (
          <>
            <span className="stream-sep">·</span>
            <span className="stream-cap">since {dayLabel(funnel.statsFrom)}</span>
            <span
              className="info-dot"
              data-tip={`On Record's ${network} record starts ${dayLabel(funnel.statsFrom)}. The counts here and every panel below the chart start there.${
                funnel.archiveVolume?.length ? " The chart before it is the Old Faithful archive." : ""
              }`}
              tabIndex={0}
              role="note"
            >
              i
            </span>
          </>
        ) : null}
        <span className="stream-sep">·</span>
        <span>{groupNum(raw)} programs</span>
        <span className="stream-sep">·</span>
        <span>
          {groupNum(funnel.deploys)} new · {groupNum(funnel.upgrades)} upgrades
        </span>
        {funnel.capped ? (
          <>
            <span className="stream-sep">·</span>
            <span className="stream-cap">stats capped at 48h · chart shows {win}</span>
          </>
        ) : null}
      </div>

      {funnel.volume && funnel.volume.length > 0 ? (
        <section className="stat-card stat-card-wide">
          <SectionHeader
            title="Deploys over time"
            info={`New deploys and upgrades, stacked, per time bucket. This chart is the one panel that shows both clusters — mainnet solid, devnet faded, on a shared scale — so their volumes are comparable; every other panel on this page is the selected cluster only. The window buttons above drive the whole page. Older buckets undercount — the loader only stores each program's last deploy slot. On 90d and longer: one bar per day or week, and on mainnet the bars before the record starts come from the Old Faithful archive, every deploy and upgrade instruction since ${ARCHIVE_FROM}.`}
          />
          {/* the comparison is mainnet-vs-devnet, so only pair them up while
              viewing mainnet — in devnet mode devnet is already the main series */}
          <FlowChart
            volume={funnel.volume}
            devnetVolume={network === "mainnet" ? funnel.volumeByNetwork?.devnet : undefined}
            networkLabel={network}
            recordStartsAt={funnel.recordStartsAt}
            devnetStartsAt={network === "mainnet" ? funnel.recordStartsAtByNetwork?.devnet : undefined}
            archiveVolume={funnel.archiveVolume}
            windowSecs={windowSecs}
          />
        </section>
      ) : null}

      <div className="stat-grid">
        <section className="stat-card">
          <SectionHeader
            title="Frameworks"
            info="Framework each program was built with. Anchor v2 is counted apart from earlier Anchor; Quasar is named from the program's source, since its binary reads as Pinocchio. Arrow = share change, first half vs second half of the window."
          />
          {funnel.frameworkTrend && funnel.frameworkTrend.length > 0 ? (
            <div className="trend-list">
              {funnel.frameworkTrend.map((t) => {
                const dir = t.delta > 0.02 ? "up" : t.delta < -0.02 ? "down" : "flat";
                const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
                const facet = STATS_FRAMEWORK_FACET[t.framework];
                const cells = (
                  <>
                    <span className="trend-name">{t.framework}</span>
                    <span className="trend-count">{t.current}</span>
                    <span className="trend-share">
                      {Math.round(t.earlyShare * 100)}% → {Math.round(t.lateShare * 100)}%
                    </span>
                    <span className={`trend-delta trend-${dir}`}>
                      {arrow} {t.delta >= 0 ? "+" : ""}
                      {Math.round(t.delta * 100)}pp
                    </span>
                  </>
                );
                const href = facet ? radar({ framework: facet }) : undefined;
                return href ? (
                  <Link className="trend-row is-link" href={href} key={t.framework}>
                    {cells}
                  </Link>
                ) : (
                  <div className="trend-row" key={t.framework}>
                    {cells}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        {funnel.disclosure && funnel.disclosure.total > 0 ? (
          <section className="stat-card">
            <SectionHeader
              title="IDL, security.txt, verified"
              info="Share of the window's deploys and upgrades that published each one, every program once as it stands now. IDL: found when the program was deployed (Anchor IDL account or Program Metadata). security.txt: in the binary or the Program Metadata account. Verified: the build matches public source (OtterSec)."
            />
            <div className="cat-breakdown">
              {(
                [
                  ["IDL", funnel.disclosure.idl],
                  ["security.txt", funnel.disclosure.securityTxt],
                  ["verified build", funnel.disclosure.verified],
                  ["all three", funnel.disclosure.allThree],
                ] as const
              ).map(([label, n]) => (
                <div className="cat-bar-row" key={label}>
                  <span className="cat-chip" style={{ minWidth: 116, textAlign: "left" }}>
                    {label}
                  </span>
                  <div className="cat-bar-track">
                    <div className="cat-bar" style={{ width: `${pct(n, funnel.disclosure!.total)}%` }} />
                  </div>
                  <span className="cat-bar-num">
                    {pct(n, funnel.disclosure!.total)}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="stat-card">
          <SectionHeader
            title="Categories"
            info="Category from the recovered name or IDL. 'unknown' = not enough to tag."
          />
          <Breakdown
            rows={CATEGORY_ORDER.map((c) => [
              categoryLabel(c),
              funnel.byCategory[c] ?? 0,
              undefined,
              c === "unknown" ? undefined : radar({ category: c }),
            ])}
            labelWidth={80}
          />
        </section>

        {funnel.byIntegration && Object.keys(funnel.byIntegration).length > 0 ? (
          <section className="stat-card">
            <SectionHeader title="Integrations" info="Known programs referenced in the bytecode." />
            <Breakdown rows={sorted(funnel.byIntegration).slice(0, 10)} labelWidth={132} />
          </section>
        ) : null}

        {funnel.identity ? (
          <section className="stat-card">
            <SectionHeader title="Identity" info="Programs we could name or link to source, from the binary." />
            <Breakdown
              rows={[
                ["named", funnel.identity.named, "A project name was recovered from the binary."],
                ["has repo", funnel.identity.withRepo, "A source-code repo was found in the binary or a verified build.", radar({ repo: true })],
                ["opaque", funnel.identity.opaque, "No name, repo, or security.txt — anonymous bytecode."],
              ]}
            />
          </section>
        ) : null}

        {funnel.lineage ? (
          <section className="stat-card">
            <SectionHeader title="Lineage" info="Novel = no known relative. Fork = ≥60% code match to a known program." />
            <Breakdown
              rows={[
                ["novel", funnel.lineage.novel, "No known code relative on record — genuinely new code.", radar({ view: "novel" })],
                ["variant", funnel.lineage.variant, "Loosely similar to a known program, but not a direct copy.", radar({ view: "variant" })],
                ["fork", funnel.lineage.fork, "≥60% code match to a known program — a fork or close derivative.", radar({ view: "recycled" })],
              ]}
            />
          </section>
        ) : null}

        {funnel.control ? (
          <section className="stat-card">
            <SectionHeader title="Control" info="Upgrade authority. Verified = bytecode reproduces from public source." />
            <Breakdown
              rows={[
                ["mutable", funnel.control.mutable, "Has an upgrade authority — the deployer can still replace the code (including to rug)."],
                ["frozen", funnel.control.frozen, "Upgrade authority is null — the code can never be changed by anyone.", radar({ authority: "frozen" })],
                ["verified build", funnel.control.verified, "The on-chain bytecode reproduces from public source code.", radar({ verification: "verified" })],
              ]}
            />
          </section>
        ) : null}

        {funnel.buildMachine ? (
          <section className="stat-card">
            <SectionHeader
              title="Build machine"
              info="Machine that compiled each program, read from paths the compiler left in its bytes. A Mac build can't byte-match a Linux or Docker rebuild."
            />
            <Breakdown
              rows={[
                ["Mac", funnel.buildMachine.mac, "Built with the macOS platform-tools download, or on a Mac home folder."],
                ["Linux", funnel.buildMachine.linux, "Built with the Linux download. Includes Docker builds."],
                ["no clue", funnel.buildMachine.unknown, "No machine paths left in the binary: stripped or remapped at build time."],
                ...(funnel.buildMachine.unread > 0
                  ? ([["not read", funnel.buildMachine.unread, "No stored bytecode to read yet."]] as BreakdownRow[])
                  : []),
              ]}
            />
          </section>
        ) : null}

        {funnel.conviction ? (
          <section className="stat-card">
            <SectionHeader title="Funding" info="Where the deployer's SOL was traced to." />
            <Breakdown
              rows={[
                ["known entity", funnel.conviction.knownEntity, "Deployer was funded from a labeled exchange or bridge."],
                ["traced funder", funnel.conviction.funderTraced, "Funded from a specific wallet we could trace, but not a labeled entity."],
                ["untraced", funnel.conviction.untraced, "Couldn't reach the funding origin."],
              ]}
            />
          </section>
        ) : null}

        {funnel.sbpfTrend && funnel.sbpfTrend.some((t) => t.current > 0) ? (
          <section className="stat-card">
            <SectionHeader
              title="sBPF version"
              info="The sBPF version each program's bytecode targets, read from its ELF header. Counts new deploys and upgrades together, each program once at its current build. SIMD-0500 makes v3 the only version accepted for deploys and upgrades. 'not read' = recorded before the version was. Arrow = share change, first half vs second half of the window."
            />
            <div className="trend-list">
              {funnel.sbpfTrend.map((t) => {
                const dir = t.delta > 0.02 ? "up" : t.delta < -0.02 ? "down" : "flat";
                const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
                return (
                  <div className="trend-row" key={t.version}>
                    <span className="trend-name">{t.version}</span>
                    <span className="trend-count">{t.current}</span>
                    <span className="trend-share">
                      {Math.round(t.earlyShare * 100)}% → {Math.round(t.lateShare * 100)}%
                    </span>
                    <span className={`trend-delta trend-${dir}`}>
                      {arrow} {t.delta >= 0 ? "+" : ""}
                      {Math.round(t.delta * 100)}pp
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      {funnel.churn && funnel.churn.redeploys > 0 ? (
        <section className="stat-card stat-card-wide">
          <SectionHeader
            title="Recycled — byte-clone redeploys"
            info="New deploys whose bytecode is byte-identical to code already on record — the same program under a fresh id. Not novel, so the gate strips it before ranking. Byte-identical is a fact; whether it's a bot is graded below — only the Pump.fun subset is a confident sniper signature."
          />
          <div className="botshare">
            <div className="botshare-fig">
              <span className="botshare-pct">{pct(funnel.churn.redeploys, funnel.deploys)}%</span>
              <span className="botshare-lbl">
                of today&apos;s {groupNum(funnel.deploys)} new deploys are
                byte-clone redeploys, not new code
              </span>
            </div>
            <div className="botshare-bar">
              <div
                className="botshare-fill"
                style={{ width: `${pct(funnel.churn.redeploys, funnel.deploys)}%` }}
              />
            </div>
          </div>
          <Breakdown
            rows={[
              ["redeploys", funnel.churn.redeploys, "New deploys that are byte-clones of known code — same program, fresh id. A fact, not a judgment."],
              ["Pump.fun snipers", funnel.churn.pumpfun, "The confident bot subset: redeploys wired to Pump.fun — the launch-sniper signature."],
              ["already closed", funnel.churn.closed, "Deploys whose ProgramData is already gone — rent reclaimed, likely a throwaway bot that moved on."],
            ]}
            labelWidth={132}
          />
          <BotExplainer />
        </section>
      ) : null}

      <p className="funnel-updated">last {win} · updated {utcStamp(funnel.updatedAt)}</p>
    </>
  );
}
