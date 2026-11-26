"use client";

import { useState } from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { FrameworkShareChart } from "@/components/FrameworkShareChart";
import { DrillTreemap } from "@/components/DrillTreemap";
import { CardFoot, MeterList, type MeterLine, type MeterRow } from "@/components/StatBits";
import type { VersionNet, VersionRow } from "@/components/VersionCompare";

// Toolchain: one card with two tabs, Frameworks (share over time, each band
// named on the chart) and Integrations. Click a band and the section narrows to that framework's programs: its band lights, the integrations box
// shows what it calls, and sBPF and build machine count only it. Click it
// again to go back to all.

export type ToolchainFramework = {
  key: string;
  /** share of the window, 0-100 */
  share: number;
  n: number;
  /** "↑ 12pp over the window", for the hover */
  change?: string;
};

type MachineRow = { key: string; total: number; verified: number };
type FwDetail = {
  sbpf: Record<string, number>;
  machine: Record<string, { total: number; verified: number }>;
  integrations: Record<string, number>;
  v0Upgrades: number;
};

const MACHINE_LABEL: Record<string, string> = { mac: "Mac", linux: "Linux", unknown: "unknown" };
const SBPF_ORDER = ["v3", "v2", "v1", "v0"];

const num = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function ToolchainView({
  frameworks,
  frameworksInfo,
  series,
  integrations,
  sbpf,
  sbpfInfo,
  machine,
  machineInfo,
  v0Upgrades,
  v0Href,
  byFramework,
  machineDev = null,
  v0Dev = null,
  byFrameworkNet = null,
}: {
  frameworks: ToolchainFramework[];
  frameworksInfo: string;
  series: {
    points: { t: number; counts: Record<string, number> }[];
    bucketSecs: number;
    archiveUntil?: number | null;
    archiveLabel?: string;
  } | null;
  integrations: [string, number][];
  sbpf: VersionRow[];
  sbpfInfo: string;
  machine: MachineRow[];
  machineInfo: string;
  v0Upgrades: number;
  v0Href?: string;
  byFramework?: Record<
    string,
    {
      sbpf: Record<string, number>;
      machine: Record<string, { total: number; verified: number }>;
      integrations: Record<string, number>;
      v0Upgrades: number;
    }
  >;
  /** on all networks: the machine rows of each network, drawn as pairs */
  machineDev?: { mainnet: MachineRow[]; devnet: MachineRow[] } | null;
  v0Dev?: { mainnet: number; devnet: number } | null;
  /** on all networks, the per-framework counts of each network */
  byFrameworkNet?: { mainnet?: Record<string, FwDetail>; devnet?: Record<string, FwDetail> } | null;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const [tab, setTab] = useState<"time" | "integrations">(series ? "time" : "integrations");
  // narrowing needs the per-framework counts; without them the bar only lights
  const detail = pick && byFramework ? byFramework[pick] : null;
  const toggle = (fw: string) => setPick((p) => (p === fw ? null : fw));

  // the panels, overall or for the picked framework. On all networks each
  // figure is a pair, mainnet over devnet (hatched)
  const pickedNet = pick && byFrameworkNet ? { m: byFrameworkNet.mainnet?.[pick], d: byFrameworkNet.devnet?.[pick] } : null;
  const versionNetOf = (sbpfCounts: Record<string, number> | undefined, net: VersionNet["net"], v: string): VersionNet => {
    const read = SBPF_ORDER.reduce((a, k) => a + (sbpfCounts?.[k] ?? 0), 0);
    const n = sbpfCounts?.[v] ?? 0;
    return { net, n, share: read ? (n / read) * 100 : 0, early: null, late: null };
  };
  const sbpfRows: VersionRow[] = detail
    ? SBPF_ORDER.map((v) => ({
        version: v,
        nets: pickedNet
          ? [versionNetOf(pickedNet.m?.sbpf, "mainnet", v), versionNetOf(pickedNet.d?.sbpf, "devnet", v)]
          : [versionNetOf(detail.sbpf, null, v)],
      }))
    : sbpf;
  const fmtPct = (x: number) => (x > 0 && x < 1 ? x.toFixed(1) : String(Math.round(x)));
  const versionLine = (n: VersionNet): MeterLine => {
    const moved = n.early != null && n.late != null;
    return {
      value: moved ? (
        <>
          <span className="vc-from">{fmtPct(n.early!)}% →</span>&nbsp;<span className="vc-to">{fmtPct(n.late!)}%</span>
        </>
      ) : (
        <span className="vc-to">{fmtPct(n.share)}%</span>
      ),
      frac: (moved ? n.late! : n.share) / 100,
      tip: `${num(n.n)} programs`,
      trend: moved
        ? {
            pp: Math.round(n.late! - n.early!),
            title: `${fmtPct(n.early!)}% of the window's first half → ${fmtPct(n.late!)}% of its second`,
          }
        : null,
    };
  };
  const sbpfMeter: MeterRow[] = sbpfRows.map((r) => ({
    label: r.version,
    ...versionLine(r.nets[0]!),
    dev: r.nets[1] ? versionLine(r.nets[1]) : null,
  }));

  const machineOf = (m: Record<string, { total: number; verified: number }>): MachineRow[] =>
    (["unknown", "linux", "mac"] as const).filter((k) => m[k]).map((k) => ({ key: k, ...m[k]! }));
  const machineRows: MachineRow[] = (detail ? machineOf(detail.machine) : machine).sort((a, b) => b.total - a.total);
  const machinePair = detail
    ? pickedNet
      ? { mainnet: machineOf(pickedNet.m?.machine ?? {}), devnet: machineOf(pickedNet.d?.machine ?? {}) }
      : null
    : machineDev;
  const machineLine = (rows: MachineRow[], key: string): MeterLine => {
    const total = rows.reduce((a, r) => a + r.total, 0);
    const r = rows.find((x) => x.key === key) ?? { key, total: 0, verified: 0 };
    return {
      value: `${num(r.total)} · ${pct(r.verified, r.total)}% verified`,
      frac: total ? r.total / total : 0,
    };
  };
  const machineMeter: MeterRow[] = machineRows.map((r) =>
    machinePair
      ? {
          label: MACHINE_LABEL[r.key] ?? r.key,
          ...machineLine(machinePair.mainnet, r.key),
          dev: machineLine(machinePair.devnet, r.key),
        }
      : { label: MACHINE_LABEL[r.key] ?? r.key, ...machineLine(machineRows, r.key) },
  );
  const integ: [string, number][] = detail
    ? Object.entries(detail.integrations).sort((a, b) => b[1] - a[1])
    : integrations;
  const v0 = detail ? detail.v0Upgrades : v0Upgrades;
  const v0Pair = detail
    ? pickedNet
      ? { mainnet: pickedNet.m?.v0Upgrades ?? 0, devnet: pickedNet.d?.v0Upgrades ?? 0 }
      : null
    : v0Dev;

  return (
    <>
      <section className="stat-card stat-span">
        {/* two tabs and one chart slot; Frameworks first */}
        <div className="tc-tabs" role="tablist">
          {series ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "time"}
              className={`tc-tab${tab === "time" ? " is-on" : ""}`}
              onClick={() => setTab("time")}
            >
              Frameworks
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "integrations"}
            className={`tc-tab${tab === "integrations" ? " is-on" : ""}`}
            onClick={() => setTab("integrations")}
          >
            Integrations
          </button>
          <span
            className="info-dot tc-info"
            data-tip={tab === "time" ? frameworksInfo : "Known programs referenced in the window's new deploys, counted once per distinct binary on each network. Click a block of several to open it."}
            tabIndex={0}
            role="note"
          >
            i
          </span>
          {pick ? (
            <button type="button" className="tc-clear" onClick={() => setPick(null)}>
              {pick} only · show all
            </button>
          ) : null}
        </div>
        {tab === "time" && series ? (
          <>
            <FrameworkShareChart
              points={series.points}
              bucketSecs={series.bucketSecs}
              order={frameworks.map((f) => f.key)}
              highlight={pick}
              onPick={toggle}
              archiveUntil={series.archiveUntil ?? null}
              archiveLabel={series.archiveLabel}
            />
          </>
        ) : integ.length ? (
          <DrillTreemap key={pick ?? "all"} items={integ} />
        ) : (
          <p className="tc-empty">No known programs referenced.</p>
        )}
      </section>

      <section className="stat-card">
        <SectionHeader title="sBPF version" info={sbpfInfo} />
        <MeterList rows={sbpfMeter} />
        {v0 > 0 ? (
          <CardFoot
            label="upgraded, still on v0"
            value={num(v0Pair ? v0Pair.mainnet : v0)}
            devValue={v0Pair ? num(v0Pair.devnet) : null}
            href={detail ? undefined : v0Href}
          />
        ) : null}
      </section>

      <section className="stat-card">
        <SectionHeader title="Build machine" info={machineInfo} />
        <MeterList rows={machineMeter} />
      </section>
    </>
  );
}
