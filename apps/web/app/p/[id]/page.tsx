import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Chevron } from "@/components/Chevron";
import { parseAuditors, parseContacts } from "@/lib/securitytxt";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackToRadar } from "@/components/BackToRadar";
import { ClusterUrlSync } from "@/components/ClusterUrlSync";
import { isIndexable } from "@/lib/indexable";
import { CopyAddress } from "@/components/CopyAddress";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { ClusterBadge } from "@/components/ClusterBadge";
import { IdlViewer } from "@/components/IdlViewer";
import { UsageSection } from "@/components/UsageSection";
import { ComputeSection } from "@/components/ComputeSection";
import { DossierTabs, type DossierTab } from "@/components/DossierTabs";
import { ClusterSwitch } from "@/components/ClusterSwitch";
import { RecordTable } from "@/components/RecordTable";
import { ArchivedProgram } from "@/components/ArchivedProgram";
import { rebuiltFromSource, machineLabel } from "@/lib/rebuilds";
import { SignalHex } from "@/components/SignalHex";
import { Sparkline } from "@/components/Sparkline";
import { deriveSignals } from "@/lib/signals";
import { deriveComposition } from "@/lib/composition";
import { TIER_ORDER } from "@/lib/primitives";
import { deriveLifecycle, botKind, BOT_LABEL } from "@/lib/lifecycle";
import { ANCHOR_LINE, builtWith } from "@/lib/frameworks";
import { BotExplainer } from "@/components/BotExplainer";
import { SectionHeader } from "@/components/SectionHeader";
import { SaveButton } from "@/components/SaveButton";
import { Lineage, lineageSummary } from "@/components/Lineage";
import { ReachMap } from "@/components/Reach";
import { RenderedAgo } from "@/components/RenderedAgo";
import {
  categoryLabel,
  fetchCluster,
  fetchIdl,
  fetchProgram,
  fetchUsage,
  fetchVerification,
  fetchVersions,
  fetchArchive,
  versionsBySlot,
  builderHref,
  orbAddress,
  orbTx,
  type ApiProgramDetail,
  type ApiRawEvent,
  type SecurityTxt,
} from "@/lib/api";
import {
  dayStamp,
  formatBytes,
  isSyntheticSignature,
  relativeTime,
  shortUrl,
  truncateAddress,
} from "@/lib/format";

const EVENT_LABELS: Record<ApiRawEvent["type"], string> = {
  deploy: "DEPLOY",
  upgrade: "UPGRADE",
  set_authority: "SET AUTHORITY",
  close: "CLOSE",
};

// Size bar fill: log scale across the range programs actually occupy (~8 KB to
// ~4 MiB), NOT the 10 MiB account ceiling almost nothing reaches. This keeps the
// fill aligned with the lean/moderate/heavy bands; true whales (4 MiB+) cap at full.
function sizeFillPct(bytes: number): number {
  const FLOOR = Math.log10(8 * 1024);
  const CEIL = Math.log10(4 * 1024 * 1024);
  const p = (Math.log10(bytes) - FLOOR) / (CEIL - FLOOR);
  return Math.max(3, Math.min(100, p * 100));
}

// Cached, rendered at most once per window per program. Every dossier used to
// be a fresh server render, which is what let crawlers burn the Vercel CPU
// allowance (see app/robots.ts). An empty list still opts the route into ISR:
// pages render on first visit, then serve from cache.
// A day: ingest pushes a rebuild when the record changes (app/api/revalidate).
// At an hour, crawlers walking the corpus re-rendered ~9K pages a day, which
// spent the Vercel Hobby CPU and ISR-write allowances and paused the site
// (22 Oct 2026). "Last 24h" only moves with the clock, so it carries the age
// of the render (<RenderedAgo>) and a day-old count never reads as current.
export const revalidate = 86400;
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const program = await fetchProgram(id);
  const label = program?.name ?? truncateAddress(id);
  // kept ≲125 chars so social previews don't truncate it (og:description)
  const description = program
    ? `${program.deployType === "upgrade" ? "Upgraded" : "New"} Solana program — ${
        builtWith(program.framework, program.anchor) ? `${builtWith(program.framework, program.anchor)}, ` : ""
      }${program.sizeBytes ? formatBytes(program.sizeBytes) : "size unknown"}${
        program.deployCostSol != null ? `, ${program.deployCostSol} SOL locked` : ""
      }. Novelty, control, activity & cost, decoded on-chain.`
    : "A Solana program on On Record, a Solana program radar.";
  return {
    title: label,
    description,
    // one page per program id; ?network= only steers the banner
    // the same dossier as plain text, for AI assistants (./dossier.md/route.ts)
    alternates: {
      canonical: `/p/${encodeURIComponent(id)}`,
      types: { "text/markdown": `/p/${encodeURIComponent(id)}/dossier.md` },
    },
    robots: program && isIndexable(program) ? undefined : { index: false, follow: true },
    // the file-convention og image is picked up automatically; the twitter
    // card type must be explicit or X falls back to a small summary tile
    twitter: { card: "summary_large_image" },
  };
}

/** one label/value row */
function Row({
  label,
  children,
  explain,
}: {
  label: string;
  children: React.ReactNode;
  /** a "what does this mean" body — the row itself becomes the toggle, so the
   *  fact and its explanation sit together instead of in a second box below */
  explain?: React.ReactNode;
}) {
  if (!explain) {
    return (
      <div className="fact-row">
        <span className="fact-label">{label}</span>
        <span className="fact-value">{children}</span>
      </div>
    );
  }
  return (
    <details className="fact-row-toggle">
      <summary className="fact-row">
        <span className="fact-label">{label}</span>
        <span className="fact-value">{children}</span>
        <Chevron className="explainer-chev" />
      </summary>
      <div className="fact-explain">{explain}</div>
    </details>
  );
}

/** A declared repo the liveness sweep found gone is shown once, as text,
 *  under the binary panel — never as a working link in any panel. */
function withoutDeadRepo(fields: SecurityTxt, dead: string | null): SecurityTxt {
  if (!dead || !fields.source_code || fields.source_code.trim() !== dead) return fields;
  const { source_code: _gone, ...rest } = fields;
  return rest;
}

/** the deployer: a person glyph, in the header next to the calendar */
function DeployerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}

function Ext({ href, text }: { href: string; text: string }) {
  return (
    <a className="receipt-link" href={href} target="_blank" rel="noopener noreferrer">
      {text}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** A bare external link that shows an icon instead of a label — the tooltip
 *  carries the meaning. Keeps the header sub-row clean when there are several. */
function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      className="icon-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
    >
      {children}
    </a>
  );
}

const ICON = {
  viewBox: "0 0 16 16",
  width: 15,
  height: 15,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

// a planet/orb — a disc with an orbit ring, for the Orb explorer
const OrbIcon = () => (
  <svg {...ICON}>
    <circle cx="8" cy="8" r="5.1" />
    <ellipse cx="8" cy="8" rx="5.1" ry="2.1" />
  </svg>
);
// angle brackets — source code
const CodeIcon = () => (
  <svg {...ICON}>
    <path d="M6 5 3 8l3 3" />
    <path d="m10 5 3 3-3 3" />
  </svg>
);
// globe — website
const GlobeIcon = () => (
  <svg {...ICON}>
    <circle cx="8" cy="8" r="5.1" />
    <path d="M2.9 8h10.2" />
    <path d="M8 2.9c1.7 1.6 1.7 8.6 0 10.2M8 2.9c-1.7 1.6-1.7 8.6 0 10.2" />
  </svg>
);
// speech bubble — social
const SocialIcon = () => (
  <svg {...ICON}>
    <path d="M13.2 8.2A4.4 4.4 0 0 1 6.9 12L3 13l.9-3.3a4.4 4.4 0 1 1 9.3-1.5Z" />
  </svg>
);
// calendar — first-deploy date
const CalendarIcon = () => (
  <svg {...ICON} width={13} height={13}>
    <rect x="2.8" y="3.4" width="10.4" height="9.6" rx="1.4" />
    <path d="M2.8 6.3h10.4M5.5 2.3v2.2M10.5 2.3v2.2" />
  </svg>
);

export default async function ProgramDossierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const program = await fetchProgram(id);
  if (!program) {
    // never seen live: the archive may still hold its record (closed programs, mostly)
    const archived = await fetchArchive(id);
    if (!archived) notFound();
    return <ArchivedProgram program={archived} trail={versionsBySlot(await fetchVersions(id))} />;
  }
  const renderedAt = new Date().toISOString();

  // The interface (IDL) + its real usage. Always ask rather than trusting
  // idlPresent: that flag is a snapshot taken once at ingest, and teams often
  // publish the IDL in a separate transaction AFTER deploying — so a program
  // that shipped one later stayed false forever and the tab confidently claimed
  // no IDL existed (horse-fun had 22 instructions published). The IDL endpoint
  // does a live on-chain lookup, so the flag buys nothing but staleness.
  // Verification is labelled per version, and only exists for a mainnet
  // deployment; a failed or slow check renders the record without it.
  const onMainnet = program.events.some((e) => e.network === "mainnet");
  const [idl, storedUsage, versions, verification] = await Promise.all([
    fetchIdl(id),
    fetchUsage(id),
    fetchVersions(id),
    onMainnet ? fetchVerification(id) : Promise.resolve(null),
  ]);
  const trail = versionsBySlot(versions);
  // On Record's own rebuild from public source, shown only for programs without
  // an OtterSec verification and only while the deployed bytes are the ones rebuilt
  const rebuild = program.verified ? null : rebuiltFromSource(id, verification?.current?.hash);
  const usage = storedUsage.usage;
  const usageSampledAt = storedUsage.sampledAt;

  // the code family: other deploys of (nearly) this bytecode
  const cluster = program.bucketId ? await fetchCluster(program.bucketId) : null;
  const family = cluster && cluster.members.length > 1 ? cluster : null;

  // The record is an event log: what happened to THIS program id, with a
  // receipt for each. Sibling deploys are other programs existing, not events
  // here — they belong in Lineage, which owns "related programs".
  //
  // Split by cluster, never mixed. One program id can carry a deployment on
  // each cluster, and a single chronological list gave no way to tell a devnet
  // upgrade from a mainnet one — the slot number was the only clue, which asks
  // the reader to know that devnet runs ~80M slots ahead. Primary cluster
  // first, because that is the deployment the rest of the page describes.
  const byRecency = (a: { blockTime: string | null }, b: { blockTime: string | null }) =>
    (b.blockTime ? Date.parse(b.blockTime) : 0) - (a.blockTime ? Date.parse(a.blockTime) : 0);
  const eventsOn = (net: string) =>
    program.events.filter((e) => e.network === net).sort(byRecency);
  const primaryEvents = eventsOn(program.network);
  const otherCluster = program.network === "mainnet" ? "devnet" : "mainnet";
  const otherEvents = eventsOn(otherCluster);

  const mutability =
    program.authorityClass === "none"
      ? "immutable (frozen)"
      : program.authorityClass
        ? "mutable"
        : "unknown";

  const comp = deriveComposition(program);
  const build = program.build;
  const vcur = program.network === "mainnet" ? verification?.current ?? null : null;

  // The record, deduplicated. The loader record and the live poller can
  // both log the same event — one with its transaction, one observed from
  // account state with no signature — so a slot shows once, receipt preferred.
  const timeline = (() => {
    const seen = new Map<string, ApiProgramDetail["events"][number]>();
    for (const e of [...program.events].sort(byRecency)) {
      const k = `${e.network}:${e.type}:${e.slot}`;
      const had = seen.get(k);
      if (!had || (isSyntheticSignature(had.signature) && !isSyntheticSignature(e.signature))) seen.set(k, e);
    }
    return [...seen.values()].sort(byRecency);
  })();
  const mainnetTimeline = timeline.filter((e) => e.network === "mainnet");
  const devnetTimeline = timeline.filter((e) => e.network === "devnet");

  // Compiled on: the binary's own paths first. When they were stripped, a
  // byte-for-byte rebuild still answers it — the Mac and Linux compilers
  // produce different bytes, so the machine that reproduced the program is the
  // kind it was built on. OtterSec rebuilds in a Linux Docker image.
  const otterMatched = !!(program.verified || vcur?.status === "verified");
  const rebuiltOn: "mac" | "linux" | null = rebuild
    ? rebuild.machine === "ubuntu-latest" ? "linux" : "mac"
    : otterMatched ? "linux" : null;
  const machine = build?.download ?? build?.home ?? rebuiltOn;
  const machineFrom = build?.download
    ? `Read from the ${build.download === "mac" ? "macOS" : "Linux"} compiler paths in the binary: ${build.downloadEvidence ?? ""}…`
    : build?.home
      ? `Read from the ${build.home === "mac" ? "/Users/" : "/home/"} folder in the binary's dependency paths.`
      : rebuild
        ? `The binary has no build paths; On Record's rebuild on ${machineLabel(rebuild.machine)} matched it byte for byte.`
        : otterMatched
          ? "The binary has no build paths; OtterSec's Linux Docker rebuild matched it byte for byte."
          : "The binary carries no build paths, and no rebuild has matched it.";

  const OTTER_SHORT: Record<string, string> = {
    "not-verified": "OtterSec rebuilt the recipe and got different bytes.",
    "never-submitted": "Never submitted for verification.",
    "verified-older-build": "Verified, but for an older build.",
  };
  const upgrades = program.upgradeCount ?? timeline.filter((e) => e.type === "upgrade").length;

  // Toolchain: the Solana release (whose cargo-build-sbf picks the compiler)
  // that reproduced these bytes. Exact only where a rebuild matched; otherwise
  // the SDK crate version if the binary names one, which is what the code was
  // written against, not what built it — labelled as such.
  const sdk = build?.crates.find((c) => c.name === "solana-program");
  const toolchainValue: ReactNode = rebuild ? (
    `Solana ${rebuild.solana}`
  ) : sdk ? (
    <>
      {sdk.version}
      <span className="ov-note">sdk</span>
    </>
  ) : (
    <span className="cell-dim">—</span>
  );
  const toolchainTip = rebuild
    ? `The Solana release whose cargo-build-sbf reproduced these bytes, byte for byte, in On Record's rebuild on ${machineLabel(rebuild.machine)}. The release picks the compiler (platform-tools) by default.`
    : sdk
      ? `The binary was compiled against solana-program ${sdk.version}, read from its dependency paths. That's the SDK the code uses, not the Solana release that built it.`
      : "The Solana release and compiler that built it. Known exactly for programs On Record has rebuilt; reading the compiler straight from the binary is next.";

  // Twelve cells, the same twelve on every program, in the same places. What
  // isn't known reads "—"; nothing appears or disappears. Explanations live in
  // the label's tooltip, never on the page.
  const cells: { k: string; tip: string; v: ReactNode; bar?: ReactNode }[] = [
    {
      k: "verified",
      tip: otterMatched
        ? "OtterSec rebuilt the published source and got exactly the deployed bytes."
        : rebuild
          ? `On Record rebuilt ${rebuild.repo.replace("https://github.com/", "")} @ ${rebuild.commit.slice(0, 7)} with Solana ${rebuild.solana} and got exactly the deployed bytes.${vcur && OTTER_SHORT[vcur.status] ? ` OtterSec: ${OTTER_SHORT[vcur.status]}` : ""}`
          : !onMainnet
            ? "OtterSec's verifier only covers mainnet."
            : (vcur?.diagnosis ?? "No verified build on record."),
      v: otterMatched ? (
        <span className="vfy-yes">✓ OtterSec</span>
      ) : rebuild ? (
        <Link className="vfy-or" href={`/p/${id}/rebuild`} prefetch={false}>
          ✓ On Record
        </Link>
      ) : !onMainnet ? (
        <span className="cell-dim">not checked</span>
      ) : (
        <span className="cell-dim">no</span>
      ),
    },
    {
      k: "crate",
      tip: "The Rust crate the program was built from, read from the panic paths left in the binary (programs/<crate>/src/…). Programs built from the same source share it.",
      v: program.crate ?? comp.crate ?? <span className="cell-dim">—</span>,
    },
    {
      k: "framework",
      tip: [
        comp.framework.detection || "Read off the binary: the syscall ABI and marker strings.",
        program.anchor ? `${ANCHOR_LINE[program.anchor.line].label}: ${program.anchor.evidence.join("; ")}.` : null,
        program.frameworkSource === "source" && program.sourceFramework
          ? `Named by its source repo ${program.sourceFramework.repo}, where the binary can't tell.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      v: comp.framework.label ? (
        <>
          {comp.framework.label}
          {program.anchor ? <span className="cell-dim"> {ANCHOR_LINE[program.anchor.line].label}</span> : null}
        </>
      ) : (
        <span className="cell-dim">—</span>
      ),
    },
    {
      k: "control",
      tip: "Who can replace the program's code. Frozen means nobody can; a Squads multisig needs several signers.",
      v: program.multisig ? (
        <Link className="receipt-link" prefetch={false} href={builderHref(program.multisig.address, program.network)}>
          Squads{program.multisig.threshold != null && program.multisig.members != null ? ` ${program.multisig.threshold} of ${program.multisig.members}` : ""}
        </Link>
      ) : program.authorityClass === "none" ? (
        "frozen"
      ) : program.authority ? (
        <Link className="receipt-link" prefetch={false} href={builderHref(program.authority, program.network)}>
          {program.authorityClass?.replace("_", " ") ?? truncateAddress(program.authority)}
        </Link>
      ) : (
        <span className="cell-dim">{program.authorityClass?.replace("_", " ") ?? "—"}</span>
      ),
    },
    {
      k: "build machine",
      tip: machineFrom,
      v: machine === "mac" ? "Mac" : machine === "linux" ? "Linux or Docker" : <span className="cell-dim">—</span>,
    },
    {
      k: "toolchain",
      tip: toolchainTip,
      v: toolchainValue,
    },
    {
      k: "upgrades",
      tip: "Upgrades to this program id on its main cluster.",
      v: `${upgrades}${program.upgradeCountTruncated ? "+" : ""}`,
    },
    {
      k: "deployer",
      tip: "The wallet that paid for the first deploy. Opens everything else it has deployed.",
      v: program.deployer ? (
        <Link className="receipt-link" prefetch={false} href={builderHref(program.deployer, program.network)}>
          {truncateAddress(program.deployer)}
        </Link>
      ) : (
        <span className="cell-dim">—</span>
      ),
    },
    {
      k: "lineage",
      tip: "Other programs on record built from this code — byte-identical, near-identical, or sharing a source tree. The full list is in the Code tab.",
      v: lineageSummary(program, family),
    },
    {
      k: "size",
      tip: "Size of the deployed program image. Lean is under 64 KB, moderate under 256 KB, heavy above that. The bar is log scale from 8 KB to 4 MB.",
      v:
        comp.sizeBytes != null ? (
          <>
            {formatBytes(comp.sizeBytes)}
            {comp.sizeBand ? <span className={`ov-note size-band-${comp.sizeBand}`}>{comp.sizeBand}</span> : null}
          </>
        ) : (
          <span className="cell-dim">—</span>
        ),
      bar:
        comp.sizeBytes != null ? (
          <div className="ov-bar">
            <div
              className={`size-fill-${comp.sizeBand ?? "moderate"}`}
              style={{ width: `${sizeFillPct(comp.sizeBytes)}%` }}
            />
          </div>
        ) : null,
    },
    {
      k: "instructions",
      tip: "Instruction handlers, from the IDL or recovered from the binary.",
      v: comp.instructions.length || program.instructionCount || <span className="cell-dim">—</span>,
    },
    {
      k: "deploy cost",
      tip: "SOL locked as rent to hold the program on-chain.",
      v: program.deployCostSol != null ? `${program.deployCostSol} SOL` : <span className="cell-dim">—</span>,
    },
  ];

  // security.txt as a receipt: the same eight lines every time, dashes where
  // the developer wrote nothing, so the block never changes size
  const sec = program.securityTxt ?? (program.pmpSecurityTxt?.counts ? program.pmpSecurityTxt.fields : null);
  const secFields = sec ? withoutDeadRepo(sec, program.repoUrlDeclared) : null;
  const secWhere = [program.securityTxt ? "in binary" : null, program.pmpSecurityTxt?.counts ? "in PMP account" : null]
    .filter(Boolean)
    .join(" + ");
  const RECEIPT: [keyof SecurityTxt | "found", string][] = [
    ["found", "found"],
    ["name", "name"],
    ["project_url", "project url"],
    ["contacts", "contacts"],
    ["policy", "policy"],
    ["source_code", "source code"],
    ["source_revision", "revision"],
    ["auditors", "auditors"],
  ];
  const receiptValue = (key: keyof SecurityTxt, raw: string): ReactNode => {
    if (key === "contacts" || key === "auditors") {
      const parts = key === "contacts" ? parseContacts(raw) : parseAuditors(raw);
      return parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ", " : ""}
          {p.kind === "link" ? (
            <a className="receipt-link" href={p.href} target={p.href.startsWith("mailto:") ? undefined : "_blank"} rel="noopener noreferrer">
              {p.text}
            </a>
          ) : (
            p.text
          )}
        </span>
      ));
    }
    return /^https?:\/\/\S+$/i.test(raw) ? (
      <a className="receipt-link" href={raw} target="_blank" rel="noopener noreferrer">
        {shortUrl(raw)}
      </a>
    ) : (
      raw
    );
  };


  const lifecycle = deriveLifecycle(program);
  const botClass = botKind(program); // 'sniper' | 'throwaway' | 'duplicate' | null

  // Code: the place a program's source will live. Today that's what can be
  // recovered from the binary — its own source tree first, then its versions
  // and relatives, then what the bytes contain, then its security.txt.
  const crateName = program.crate ?? comp.crate;
  // crate versions read from the full binary (the API) first, then whatever
  // the page's string sample adds; the sample alone can't prove there are none
  const deps = [
    ...new Set([...(build?.crates ?? []).map((c) => `${c.name}-${c.version}`), ...comp.deps]),
  ];
  const compositionPanel = (
    <>
      <SectionHeader
        title="Source"
        info="The developer's own Rust source structure, recovered from panic paths and symbols left in the binary. Rust standard-library paths are filtered out."
      />
      <div className="facts-panel">
        <Row label="Crate">
          {crateName ? <span className="crate-name">{crateName}</span> : <span className="cell-dim">not in the binary</span>}
        </Row>
        <Row label="Dependencies">
          {deps.length ? (
            <span className="chip-inline">
              {deps.map((d) => (
                <span className="dep-chip" key={d}>
                  {d}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
      </div>
      {comp.moduleGroups.length ? (
        <div className="mod-map">
          {comp.moduleGroups.map((g) => (
            <div className="mod-group" key={g.dir}>
              <span className="mod-group-dir">{g.dir}/</span>
              <span className="mod-group-files">
                {g.files.map((f) => (
                  <span className="mod-chip" key={f}>
                    {f}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* MATCH is a measurement, so it mostly explains itself. This says what
          is being measured, and covers the two cases where a word appears in
          place of a figure. */}
      <SectionHeader
        title="Lineage"
        info="Every program built from this code, oldest first. MATCH is how much of the compiled bytecode is the same as this program's — 100% is the same image under a different address. LOOKALIKE means the resemblance is generic enough to mean nothing, so no figure is given. SAME SOURCE means the two share a source tree recovered from panic paths in the binary, but the builds are too far apart in size to score."
      />
      <Lineage program={program} family={family} />

      <SectionHeader
        title="Contents"
        info="What the bytes contain. Syscalls are the runtime services it imports. Embedded = a program id found verbatim in the bytecode (confirmed). Named in source = a protocol named in the recovered source paths (a strong hint, not proof of a call)."
      />
      <div className="facts-panel">
        <Row label="Syscalls">
          {comp.syscallCount ?? <span className="cell-dim">—</span>}
          {program.syscalls?.length ? (
            <span className="chip-inline" style={{ marginLeft: 10 }}>
              {program.syscalls.slice(0, 12).map((sc) => (
                <span className="ix-chip ix-chip-soft" key={sc}>
                  {sc.replace(/^sol_/, "")}
                </span>
              ))}
            </span>
          ) : null}
        </Row>
        <Row label="Embedded">
          {comp.embeddedIntegrations.length ? (
            <span className="chip-inline">
              {comp.embeddedIntegrations.map((it) => (
                <span className="ix-chip" key={it}>
                  {it}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">no known program id</span>
          )}
        </Row>
        <Row label="Named in source">
          {comp.sourceReach.length ? (
            <span className="chip-inline">
              {comp.sourceReach.map((it) => (
                <span className="ix-chip ix-chip-soft" key={it}>
                  {it}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
      </div>
      {/* closed by default: the rarity tiers are a corpus statistic dressed as
          a game, useful to whoever opens them and noise on a first read */}
      {comp.primitives.items.length ? (
        <details className="prim-more">
          <summary>Syscalls by how rare they are</summary>
          <div className="facts-panel" style={{ marginTop: 8 }}>
            <div className="fact-row">
              <span className="fact-label">Primitives</span>
              <div className="fact-value">
                <div className="prim-groups">
                  {TIER_ORDER.map((tier) => {
                    const inTier = comp.primitives.items.filter((p) => p.tier === tier);
                    if (!inTier.length) return null;
                    return (
                      <div className="prim-group" key={tier}>
                        <span className={`prim-group-tier tier-${tier}`}>{tier}</span>
                        <span className="chip-inline">
                          {inTier.map((p) => (
                            <span className="ix-chip" key={p.label} title={p.explain}>
                              {p.label}
                            </span>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </details>
      ) : null}

      {/* security.txt is text the developer embedded in the binary (or a PMP
          account): what we read out of it, like the rest of this tab */}
      <SectionHeader
        title="Security.txt"
        info="The developer's own contact block, published in the binary (the Neodyme convention) or in a Program Metadata account. Self-declared: a claim, not proof."
      />
      <div className="receipt">
        {RECEIPT.map(([key, label]) => {
          const raw = key === "found" ? secWhere : secFields?.[key]?.trim();
          return (
            <div className="receipt-line" key={key} title={raw || undefined}>
              <span className="receipt-kcol">
                <span className="receipt-k">{label}</span>
                <i className="receipt-dots" aria-hidden="true" />
              </span>
              <span className={`receipt-v${raw ? "" : " cell-dim"}`}>
                {raw ? (key === "found" ? raw : receiptValue(key, raw)) : key === "found" ? "nowhere" : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );

  // Traction: the rows and the 7-day graph. One
  // plain line instead of a panel of dashes when there's nothing; a missing
  // counter is not a zero, so "no transactions" only when the counters ran,
  // read zero, and no compute sample found any either.
  const series = program.activity && program.activity.length >= 2 ? program.activity : null;
  const counted = program.momentum != null || series != null || program.earlySigners != null;
  const allZero =
    (program.momentum?.txns24h ?? 0) === 0 && !(series ?? []).some((p) => p.c > 0) && !program.earlySigners;
  const quietLine = !counted
    ? "Traffic not counted yet."
    : allZero && !(program.compute?.n ?? 0)
      ? "No transactions sampled in the last 7 days."
      : null;
  const tractionStrip = quietLine ? (
    <p className="activity-quiet cell-dim">{quietLine}</p>
  ) : (
    <div className="facts-panel" style={{ marginBottom: 18 }}>
      {program.momentum ? (
        <Row label="Last 24h">
          {program.momentum.txns24h.toLocaleString("en-US")}
          {program.momentum.txns24hTruncated ? "+" : ""} txns
          {program.momentum.growth != null ? (
            <span className="cell-dim"> · ×{program.momentum.growth} vs prior day</span>
          ) : null}
          <RenderedAgo at={renderedAt} />
        </Row>
      ) : null}
      {series ? (
        <Row label="Activity (7d)">
          <Sparkline points={series} title="hourly transactions, last 7 days" />
        </Row>
      ) : null}
      {program.earlySigners != null ? (
        <Row label="Early activity">
          {`${program.earlySigners >= 1000 && program.earlySigners % 1000 === 0 ? `${program.earlySigners.toLocaleString("en-US")}+` : program.earlySigners.toLocaleString("en-US")} txns in the first 24h`}
        </Row>
      ) : null}
    </div>
  );

  const overviewPanel = (
    <>
      <div className="ov-grid">
        {cells.map((c) => (
          <div className="ov-cell" key={c.k}>
            <span className="ov-k tip" data-tip={c.tip} tabIndex={0}>
              {c.k}
            </span>
            <span className="ov-v">{c.v}</span>
            {c.bar}
          </div>
        ))}
      </div>

      <SectionHeader
        title="Deploys and upgrades"
        info="Every loader event on this program id, each with the transaction that proves it. The same id can be deployed on both clusters; each keeps its own history."
      />
      <ClusterSwitch
        initial={mainnetTimeline.length || !devnetTimeline.length ? "mainnet" : "devnet"}
        mainnet={
          mainnetTimeline.length ? (
            <RecordTable
              events={mainnetTimeline}
              trail={trail}
              verification={verification?.versions}
              rebuilt={
                rebuild
                  ? { hash: rebuild.hash, from: `${rebuild.repo.replace("https://github.com/", "")} at ${rebuild.commit.slice(0, 7)}` }
                  : null
              }
            />
          ) : (
            <p className="ov-none cell-dim">No mainnet deploys on record.</p>
          )
        }
        devnet={
          devnetTimeline.length ? (
            <RecordTable events={devnetTimeline} trail={trail} />
          ) : (
            <p className="ov-none cell-dim">No devnet deploys on record.</p>
          )
        }
      />
    </>
  );

  // Usage: is it used (Traction), which instructions get called, and what a
  // call costs to run
  const usagePanel = (
    <>
      <SectionHeader title="Traction" info="Is it used? Counted from sampled transactions, and accrues over time." />
      {tractionStrip}
      <UsageSection
        programId={program.id}
        initialUsage={usage}
        initialSampledAt={usageSampledAt}
        compact
      />
      <SectionHeader
        title="Compute"
        info="Compute units burned by transactions this program appears in. The figures cover the whole transaction, including every other program in it."
      />
      <ComputeSection
        programId={program.id}
        initialCompute={program.compute ?? null}
        initialRank={program.computeRank ?? null}
      />
    </>
  );

  // Where to read up, as links rather than paragraphs on the page
  const idlLearn = (
    <Row label="Learn">
      <span className="learn-links">
        <Ext href="https://www.anchor-lang.com/docs/basics/idl" text="Anchor IDL" />
        <Ext href="https://github.com/codama-idl/codama" text="Codama" />
        <Ext href="https://github.com/metaplex-foundation/shank" text="Shank" />
        <Ext href="https://github.com/solana-program/program-metadata" text="Program Metadata" />
      </span>
    </Row>
  );

  const interfacePanel = idl ? (
    <>
      <SectionHeader
        title="Interface — the on-chain IDL"
        info="The program's published IDL: every instruction, its accounts, and its types. This is what lets a client decode the program without its source."
      />
      <UsageSection programId={program.id} initialUsage={usage} initialSampledAt={usageSampledAt} />
      <IdlViewer idl={idl} />
      <div className="facts-panel" style={{ marginTop: 12 }}>{idlLearn}</div>
    </>
  ) : (
    <>
      <SectionHeader
        title="Interface"
        info="An IDL is the JSON that names a program's instructions, accounts and types, so a client can decode it without the source. Publishing one is opt-in: many teams never do, and non-Anchor programs (Pinocchio, native, Steel) have no built-in IDL at all. A missing IDL isn't a red flag."
      />
      <div className="facts-panel">
        <Row label="IDL">
          none on-chain{" "}
          <span className="cell-dim">· opt-in, often skipped</span>
        </Row>
        <Row label={comp.instructionsApprox ? "Handlers ~" : "Handlers"}>
          {comp.instructions.length ? (
            <span className="chip-inline">
              {comp.instructions.map((ix) => (
                <span className="mod-chip" key={ix}>
                  {ix}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">none recovered from the binary</span>
          )}
        </Row>
        {idlLearn}
      </div>
    </>
  );

  // Where this program sits in the stack, drawn. Its own tab rather than a row
  // in Composition — composition is what the program IS, this is its position —
  // and named Map, not Reach: Composition already owns "Reach" for the embedded
  // well-known ids, and two sections with one name on one page is just a bug.
  const mapPanel = (
    <>
      <SectionHeader
        title="Map"
        info="Which programs reach for this one, and which it reaches for. Each arrow is a program id compiled into the binary at its tail: proof the code names that program, not that it called it in any transaction. A callee passed in at runtime leaves no id behind, so the map misses links rather than inventing them."
      />
      <ReachMap
        self={{
          id: program.id,
          name: program.name,
          crate: program.crate ?? null,
          txns24h: program.momentum?.txns24h ?? null,
          txnsTruncated: program.momentum?.txns24hTruncated ?? false,
          activity: program.activity ?? null,
        }}
        references={program.references}
      />
    </>
  );
  const reachCount =
    (program.references?.names.length ?? 0) + (program.references?.namedBy.length ?? 0);

  // Overview first: everything known the minute a program is deployed, in a
  // layout that is the same shape for every program. Usage and code detail
  // follow.
  const tabs: DossierTab[] = [
    { id: "overview", label: "Overview", panel: overviewPanel },
    { id: "usage", label: "Usage", panel: usagePanel },
    // muted, not hidden: an empty map means "nothing on record names this",
    // which is a real answer, and hiding the tab would make the extraction look
    // broken on the programs it simply found nothing for.
    { id: "map", label: "Map", panel: mapPanel, muted: reachCount === 0 },
    { id: "interface", label: "Interface", panel: interfacePanel, muted: !idl },
    { id: "code", label: "Code", panel: compositionPanel },
  ];

  return (
    <>
      {/* Make the url tell the truth about the cluster, then let the one banner
          in the root layout read it. Rendering a second banner from inside the
          page was the obvious fix and the wrong one: .page is a centred, padded
          column, so that instance came out inset and pushed down while every
          other route's sat flush and full-bleed. One banner, in one place, fed
          a URL that cannot disagree with the subject. */}
      <Suspense fallback={null}>
        <ClusterUrlSync network={program.network} />
      </Suspense>
      <BackToRadar fallbackHref={program.network === "devnet" ? "/?network=devnet" : "/"} />

      <div className="dossier-head">
        <div className="dossier-head-main">
          <div className="dossier-band-line">
            <span className={`cat-chip cat-${program.category}`}>
              {categoryLabel(program.category)}
            </span>
            {builtWith(program.framework, program.anchor) ? (
              <span className="fw-chip">{builtWith(program.framework, program.anchor)}</span>
            ) : null}
            {program.deployType === "upgrade" && program.upgradeCount > 0 ? (
              <span
                className="cluster-note"
                title={
                  program.upgradeCountTruncated
                    ? "We stopped walking the deploy history at the page cap — the real count is higher"
                    : undefined
                }
              >
                upgraded ×{program.upgradeCount}
                {program.upgradeCountTruncated ? "+" : ""}
              </span>
            ) : null}
            {botClass === "recycled" ? (
              <span className="dup-chip" title="Byte-identical bytecode to other deploys on record — same code, fresh id">
                recycled
              </span>
            ) : botClass ? (
              <span
                className="bot-chip"
                title={
                  botClass === "sniper"
                    ? "Byte-clone wired to Pump.fun — the launch-sniper signature"
                    : "A byte-clone that was closed — deploy, run, close to reclaim rent"
                }
              >
                {BOT_LABEL[botClass]}
              </span>
            ) : null}
            {lifecycle.closed ? (
              <span
                className="closed-chip"
                title={
                  lifecycle.lifespanLabel
                    ? `ProgramData gone — closed within ${lifecycle.lifespanLabel} of deploy`
                    : "ProgramData account no longer exists — the program was closed"
                }
              >
                closed
                {lifecycle.lifespanLabel ? ` · ${lifecycle.lifespanLabel}` : ""}
              </span>
            ) : null}
            {/* cluster presence sits with the other chips, so the date and
                deployer line below never shifts */}
            <ClusterBadge program={program} />
          </div>

          <div className="dossier-title-row">
            <ProgramAvatar program={program} size={38} />
            <h1 className="dossier-title">
              {program.name ?? (
                <span className="dossier-title-unknown">Unidentified program</span>
              )}
              {program.verified ? (
                <VerifiedBadge size={19} />
              ) : rebuild ? (
                <Link
                  href={`/p/${id}/rebuild`}
                  prefetch={false}
                  className="verified-badge-link tip"
                  data-tip="Verified by On Record: rebuilt from public source and matched the deployed bytes exactly. Click to see the comparison."
                >
                  <VerifiedBadge size={19} issuer="onrecord" title={null} />
                </Link>
              ) : null}
            </h1>
          </div>

          <div className="dossier-sub">
            <CopyAddress value={program.id} display={program.id} className="dossier-id" />
            <span className="dossier-links">
              <IconLink href={orbAddress(program.id)} label="Open in Orb explorer">
                <OrbIcon />
              </IconLink>
              {/* the declared repo, or else one our search found — labelled as
                  found, since nobody declared it and nobody rebuilt it from it */}
              {program.repoUrl ? (
                <IconLink href={program.repoUrl} label="Source code">
                  <CodeIcon />
                </IconLink>
              ) : program.repoLink ? (
                <IconLink
                  href={program.repoLink.repoUrl}
                  label={`Source code: ${program.repoLink.repo}, found by searching public code for this program id (not declared)`}
                >
                  <CodeIcon />
                </IconLink>
              ) : null}
              {program.social ? (
                <IconLink href={program.social} label="Social">
                  <SocialIcon />
                </IconLink>
              ) : null}
              {program.website ? (
                <IconLink href={program.website} label="Website">
                  <GlobeIcon />
                </IconLink>
              ) : null}
            </span>
            <SaveButton id={program.id} name={program.name} category={program.category} network={program.network} />
          </div>
          {/* Anchor the program in time. firstDeployAt is the ORIGINAL on-chain
              deploy (from ProgramData history), not when we first saw it — so
              clicking back through lineage never loses the sense of "how old is
              this really". The tooltip carries the full context; the header
              stays to a bare date. Falls back to first-seen when unknown. */}
          {(() => {
            const first = program.firstDeployAt ?? program.deployedAt;
            if (!first && !program.deployer) return null;
            const cluster = program.network === "devnet" ? "devnet" : "mainnet";
            const verb = program.firstDeployAt != null ? "First deployed on" : "First seen on";
            return (
              <div className="dossier-deployed">
                {first ? (
                  <span className="dossier-deployed-when" title={`${verb} ${cluster} · ${relativeTime(first)}`}>
                    <CalendarIcon />
                    <span className="dossier-deployed-date">{dayStamp(first)}</span>
                  </span>
                ) : null}
                {/* the wallet that paid for the first deploy: one click to
                    everything else it has deployed (the loader record) */}
                {program.deployer ? (
                  <span className="dossier-deployer">
                    <DeployerIcon />
                    <span className="dossier-deployer-k">deployer</span>
                    <Link className="receipt-link" prefetch={false} href={builderHref(program.deployer, program.network)}>
                      {truncateAddress(program.deployer)}
                    </Link>
                  </span>
                ) : null}
              </div>
            );
          })()}
        </div>
        <div className="dossier-head-signals">
          <SignalHex signals={deriveSignals(program)} size={140} labels />
        </div>
      </div>

      {botClass === "sniper" || botClass === "throwaway" ? (
        <>
          <div className="churn-note">
            <span className="churn-note-tag">
              {botClass === "sniper" ? "sniper bot" : "throwaway bot"}
            </span>
            <p>
              This program&apos;s bytecode is{" "}
              <strong>byte-identical to other deploys on record</strong> — the
              same program under a fresh id.
              {lifecycle.closed ? (
                <>
                  {" "}It was <strong>closed within {lifecycle.lifespanLabel ?? "minutes"}</strong>
                  {program.earlySigners
                    ? <>, after <strong>{program.earlySigners.toLocaleString("en-US")}{program.earlySigners % 1000 === 0 ? "+" : ""} transactions</strong></>
                    : null}
                  .
                </>
              ) : program.earlySigners ? (
                <> It has logged <strong>{program.earlySigners.toLocaleString("en-US")}{program.earlySigners % 1000 === 0 ? "+" : ""} transactions</strong> since deploy — mostly failed attempts.</>
              ) : null}{" "}
              The signature of a throwaway bot: deploy a disposable id, run it hot
              {botClass === "sniper" ? " sniping Pump.fun launches" : ""}, then close
              it to reclaim the rent — and repeat.
            </p>
          </div>
          <BotExplainer />
        </>
      ) : botClass === "recycled" ? (
        <div className="churn-note churn-note-neutral">
          <span className="churn-note-tag churn-note-tag-neutral">recycled</span>
          <p>
            This bytecode is{" "}
            <strong>byte-identical to {program.clusterSize && program.clusterSize > 1 ? `${program.clusterSize - 1} other deploy${program.clusterSize > 2 ? "s" : ""}` : "another deploy"} on record</strong>{" "}
            — same code, fresh id. That can be a bot rotating identities,{" "}
            <em>or</em> a factory/launchpad deploying instances of one program,{" "}
            <em>or</em> a developer redeploying. We don&apos;t assume which —
            it&apos;s simply not novel code, so it&apos;s kept off the novelty radar.
          </p>
        </div>
      ) : null}

      <DossierTabs tabs={tabs} />
    </>
  );
}
