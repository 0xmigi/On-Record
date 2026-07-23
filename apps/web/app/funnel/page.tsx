import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { SectionHeader } from "@/components/SectionHeader";
import { FlowChart } from "@/components/FlowChart";
import { BotExplainer } from "@/components/BotExplainer";
import { CATEGORY_LABELS, fetchFunnel, type Category } from "@/lib/api";
import { groupNum, utcStamp } from "@/lib/format";

const WINDOW_KEYS = ["24h", "48h", "7d", "30d"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];
const WINDOW_SECS: Record<WindowKey, number> = {
  "24h": 86_400,
  "48h": 172_800,
  "7d": 604_800,
  "30d": 2_592_000,
};

export const metadata: Metadata = {
  title: "Program Stats",
  description: "Stats on every program deployed to Solana, over a time window.",
};

const CATEGORY_ORDER: Category[] = [
  "defi",
  "token",
  "nft",
  "infra",
  "governance",
  "unknown",
];

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

// each row is [label, count, optional hover definition]
type BreakdownRow = [string, number, string?];

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
      {rows.map(([label, n, tip]) => (
        <div className="cat-bar-row" key={label}>
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
        </div>
      ))}
    </div>
  );
}

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const sp = await searchParams;
  const win: WindowKey = (WINDOW_KEYS as readonly string[]).includes(sp.window ?? "")
    ? (sp.window as WindowKey)
    : "48h";
  const funnel = await fetchFunnel(win);

  if (!funnel) {
    return (
      <>
        <h1 className="funnel-title">Program Stats</h1>
        <div className="empty-state" style={{ marginTop: 24 }}>
          <Mark size={22} />
          <p className="empty-title">No data</p>
          <p className="empty-body">No programs analyzed for this window yet.</p>
        </div>
      </>
    );
  }

  const raw = funnel.raw;
  const aggH = funnel.aggregateWindowHours ?? 48;
  const sorted = (m?: Record<string, number>): [string, number][] =>
    Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <h1 className="funnel-title">Program Stats</h1>

      <nav className="chart-windows" aria-label="Time window">
        {WINDOW_KEYS.map((k) => (
          <Link
            key={k}
            href={`/funnel?window=${k}`}
            className={`chart-win-btn${win === k ? " active" : ""}`}
            aria-current={win === k ? "page" : undefined}
          >
            {k}
          </Link>
        ))}
      </nav>

      <div className="stream-status">
        <span className="stream-dot" aria-hidden="true" />
        <span className="stream-status-strong">last {aggH}h</span>
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
            info="New deploys and upgrades, stacked, per time bucket. The window buttons above drive the whole page. Older buckets undercount — the loader only stores each program's last deploy slot."
          />
          <FlowChart volume={funnel.volume} windowSecs={WINDOW_SECS[win]} />
        </section>
      ) : null}

      <div className="stat-grid">
        <section className="stat-card">
          <SectionHeader
            title="Frameworks"
            info="Framework each program was built with. Arrow = share change, first half vs second half of the window."
          />
          {funnel.frameworkTrend && funnel.frameworkTrend.length > 0 ? (
            <div className="trend-list">
              {funnel.frameworkTrend.map((t) => {
                const dir = t.delta > 0.02 ? "up" : t.delta < -0.02 ? "down" : "flat";
                const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
                return (
                  <div className="trend-row" key={t.framework}>
                    <span className="trend-name">{t.framework}</span>
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
          ) : null}
        </section>

        <section className="stat-card">
          <SectionHeader
            title="Categories"
            info="Category from the recovered name or IDL. 'unknown' = not enough to tag."
          />
          <Breakdown
            rows={CATEGORY_ORDER.map((c) => [CATEGORY_LABELS[c], funnel.byCategory[c] ?? 0])}
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
                ["has repo", funnel.identity.withRepo, "A source-code repo was found in the binary or a verified build."],
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
                ["novel", funnel.lineage.novel, "No known code relative on record — genuinely new code."],
                ["variant", funnel.lineage.variant, "Loosely similar to a known program, but not a direct copy."],
                ["fork", funnel.lineage.fork, "≥60% code match to a known program — a fork or close derivative."],
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
                ["frozen", funnel.control.frozen, "Upgrade authority is null — the code can never be changed by anyone."],
                ["verified build", funnel.control.verified, "The on-chain bytecode reproduces from public source code."],
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
