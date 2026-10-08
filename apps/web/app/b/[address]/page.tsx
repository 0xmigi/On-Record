import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackToRadar } from "@/components/BackToRadar";
import { CopyAddress } from "@/components/CopyAddress";
import { DossierTabs } from "@/components/DossierTabs";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { ProgramRow } from "@/components/ProgramRow";
import { SectionHeader } from "@/components/SectionHeader";
import {
  builderHref,
  fetchBuilder,
  looksLikeProgramId,
  orbAddress,
  type ApiBuilder,
  type ApiBuilderRelation,
  type BuilderLabel,
  type BuilderRole,
} from "@/lib/api";
import { dayStamp, truncateAddress } from "@/lib/format";

// A builder's profile: the person or team behind an address, read off what it
// did on chain. Every program it deployed, controls or helps run; how it
// handles control; what its programs publish; who it acts with. The program
// dossier's layout, for an actor instead of a contract. Reached by clicking a
// deployer, authority or multisig anywhere on the site; no nav item.

export const revalidate = 900;
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `${truncateAddress(address)} · builder`,
    description: "The Solana programs this address deployed, controls or helped run.",
    alternates: { canonical: `/b/${encodeURIComponent(address)}` },
    // profiles are reached from dossiers; keep crawlers on the dossiers
    robots: { index: false, follow: true },
  };
}

const LABEL: Record<BuilderLabel, { text: string; title: string }> = {
  "secured-team": { text: "multisig 2+ approvals", title: "Holds or sits on a Squads multisig that needs 2 or more approvals and controls a live program" },
  "serial-builder": { text: "serial", title: "Deployed two or more programs that are still running" },
  "one-shot": { text: "one program", title: "Has deployed a single program" },
  churn: { text: "churn", title: "Deploys many programs and closes most of them within a day" },
};

const ROLE: Record<Exclude<BuilderRole, "upgraded">, string> = {
  deployed: "deployed",
  controls: "controls",
  controlled: "handed off",
  paid: "paid fees",
  multisig: "is the multisig",
  member: "multisig member",
};

const RELATION: Record<ApiBuilderRelation["relation"], string> = {
  "multisig-member": "Members",
  "multisig-co-member": "Same multisig",
  "handed-control-to": "Handed control to",
  "received-control-from": "Got control from",
  "fees-paid-by": "Fees paid by",
  "paid-fees-for": "Paid fees for",
  "funded-by": "Largest sender, first tx",
  funded: "Largest sender to",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact-row">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{children}</span>
    </div>
  );
}

function Metric({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="comp-metric">
      <span className="comp-metric-v">{value}</span>
      <span className="comp-metric-k">{label}</span>
    </div>
  );
}

function BuilderLink({ address, network }: { address: string; network: ApiBuilder["network"] }) {
  return (
    <Link className="receipt-link" href={builderHref(address, network)}>
      {truncateAddress(address)}
    </Link>
  );
}

function duration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

function setup(m: ApiBuilder["summary"]["multisigs"][number]): string {
  return m.threshold != null && m.members != null ? `${m.threshold} of ${m.members}` : "Squads";
}

export default async function BuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ network?: string }>;
}) {
  const { address } = await params;
  const { network } = await searchParams;
  if (!looksLikeProgramId(address)) notFound();
  const b = await fetchBuilder(address, network === "devnet" ? "devnet" : "mainnet");
  if (!b) notFound();
  const s = b.summary;
  const d = b.disclosure;
  const ho = s.handedOff;
  const self = s.multisigs.find((m) => !m.isMember);
  const kind = self ? `Squads multisig · ${setup(self)}` : b.kind === "pda" ? "program-controlled account" : "wallet";


  // --- the tiles under the header: four numbers that say what kind of actor this is
  const tiles: ReactNode[] = [];
  if (self) {
    tiles.push(<Metric key="setup" value={setup(self)} label="approvals needed" />);
    tiles.push(<Metric key="live" value={self.programs} label="live programs held" />);
  } else {
    tiles.push(
      <Metric key="live" value={s.deployedOpen} label={s.deployed > s.deployedOpen ? `live programs · ${s.deployed} deployed` : "live programs deployed"} />,
    );
    tiles.push(
      <Metric
        key="handoff"
        value={ho.programs ? (ho.medianHoursToFirst != null ? duration(ho.medianHoursToFirst) : `${ho.programs}`) : s.deployed ? "0" : "—"}
        label={ho.programs ? (ho.medianHoursToFirst != null ? "median time to hand off authority" : "authority handoffs") : "authority handoffs"}
      />,
    );
  }
  tiles.push(<Metric key="upgrades" value={s.upgradesSigned} label="upgrades signed" />);
  tiles.push(
    s.deployed ? (
      <Metric key="devnet" value={`${s.devnetFirst.programs}/${s.devnetFirst.of}`} label="same address on devnet first" />
    ) : (
      <Metric key="disclosed" value={d.of ? `${d.repo}/${d.of}` : "—"} label="publish source" />
    ),
  );

  const handoff = [
    ho.toProgramControlled ? `${ho.toProgramControlled} to a program-controlled account` : null,
    ho.toWallet ? `${ho.toWallet} to another wallet` : null,
    ho.toNobody ? `${ho.toNobody} locked for good` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const programsPanel = (
    <ol className="radar-list">
      {b.programs.map((p) => (
        <li key={p.program.id}>
          <div className="builder-roles">
            {p.roles.map((r) => (
              <span key={r} className="builder-role">
                {r === "upgraded" ? `upgraded ×${p.upgradesSigned}` : ROLE[r]}
              </span>
            ))}
          </div>
          <ProgramRow program={p.program} />
        </li>
      ))}
    </ol>
  );

  const controlPanel = (
    <>
      <SectionHeader title="Control" info="Upgrade authority of the programs this address deployed, and the multisigs this address is or sits on." />
      <div className="facts-panel">
        {s.deployed ? (
          <Row label="Handed off">
            {ho.programs ? handoff : "none on record"}
            {ho.medianHoursToFirst != null ? ` · median ${duration(ho.medianHoursToFirst)} after deploy` : ""}
          </Row>
        ) : null}
        {s.controlsNow ? <Row label="Controls now">{s.controlsNow} live program{s.controlsNow === 1 ? "" : "s"}</Row> : null}
        {s.multisigs.map((m) => (
          <Row key={m.address} label={m.isMember ? "Sits on" : "Multisig"}>
            {setup(m)} · {m.programs} live program{m.programs === 1 ? "" : "s"}
            {m.isMember ? <> · <BuilderLink address={m.address} network={b.network} /></> : null}
          </Row>
        ))}
        {s.upgradesSigned ? (
          <Row label="Upgrade fees">
            {s.feesPaidByOthers.upgrades
              ? `${s.feesPaidByOthers.upgrades} of ${s.upgradesSigned} paid by another wallet`
              : "all paid by this address"}
          </Row>
        ) : null}
      </div>
    </>
  );

  const disclosurePanel = d.of ? (
    <>
      <SectionHeader title="Disclosure" info={`What the ${d.of} live program${d.of === 1 ? "" : "s"} this address deployed or controls publish.`} />
      <div className="comp-metrics builder-disclosure">
        <Metric value={`${d.named}/${d.of}`} label="named" />
        <Metric value={`${d.securityTxt}/${d.of}`} label="security contact" />
        <Metric value={`${d.repo}/${d.of}`} label="source code" />
        <Metric value={`${d.verified}/${d.of}`} label="verified build" />
        <Metric value={`${d.idl}/${d.of}`} label="interface (IDL)" />
        <Metric value={`${d.site}/${d.of}`} label="website or social" />
      </div>
    </>
  ) : (
    <p className="saved-hint">No live programs deployed or controlled by this address.</p>
  );

  const groups = (Object.keys(RELATION) as ApiBuilderRelation["relation"][])
    .map((kind) => ({ kind, rows: b.related.filter((r) => r.relation === kind) }))
    .filter((g) => g.rows.length);
  const networkPanel = (
    <>
      <SectionHeader title="Linked addresses" info="Addresses that appear with this one in loader transactions, on the same multisig, or as the largest sender in this address's oldest transaction. Listed as recorded; none is assumed to be the same person." />
      {groups.length || b.fundedBy ? (
        <div className="facts-panel">
          {groups.map((g) => (
            <Row key={g.kind} label={RELATION[g.kind]}>
              <span className="builder-related">
                {g.rows.map((r) => (
                  <span key={r.address}>
                    <BuilderLink address={r.address} network={b.network} />
                    {r.programs ? <span className="cell-dim"> · {r.programs}</span> : null}
                    {g.kind === "funded-by" && b.fundedBy?.busy ? <span className="cell-dim"> · 1,000+ transactions</span> : null}
                    {g.kind === "funded-by" && b.fundedBy?.at ? <span className="cell-dim"> · {dayStamp(b.fundedBy.at)}</span> : null}
                  </span>
                ))}
              </span>
            </Row>
          ))}
        </div>
      ) : (
        <p className="saved-hint">No linked addresses on record.</p>
      )}
    </>
  );

  return (
    <>
      <BackToRadar fallbackHref="/" />

      <div className="dossier-head">
        <div className="dossier-head-main">
          <div className="dossier-band-line">
            <span className="cluster-note">{kind}</span>
            {b.labels.map((l) => (
              <span key={l} className={`builder-chip builder-${l}`} title={LABEL[l].title}>
                {LABEL[l].text}
              </span>
            ))}
          </div>
          <div className="dossier-title-row">
            <ProgramAvatar program={{ id: b.address, website: null, social: null, repoUrl: null, network: b.network }} size={28} />
            <h1 className="dossier-title">{truncateAddress(b.address)}</h1>
          </div>
          <div className="dossier-sub">
            <CopyAddress value={b.address} display={b.address} className="dossier-id" />
            <span className="dossier-links">
              <a className="receipt-link" href={orbAddress(b.address)} target="_blank" rel="noopener noreferrer">
                Orb<span aria-hidden="true"> ↗</span>
              </a>
            </span>
          </div>
          {s.firstSeenAt ? (
            <div className="dossier-deployed">
              <span>active since</span>
              <span className="dossier-deployed-date">{dayStamp(s.firstSeenAt)}</span>
              {s.lastSeenAt ? <span>· last seen {dayStamp(s.lastSeenAt)}</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="comp-metrics builder-tiles">{tiles}</div>

      <DossierTabs
        tabs={[
          { id: "programs", label: `Programs · ${b.programs.length}${b.programsTruncated ? "+" : ""}`, panel: programsPanel },
          { id: "control", label: "Control", panel: controlPanel },
          { id: "disclosure", label: "Disclosure", panel: disclosurePanel, muted: !d.of },
          { id: "linked", label: "Linked", panel: networkPanel, muted: !groups.length },
        ]}
      />
    </>
  );
}
