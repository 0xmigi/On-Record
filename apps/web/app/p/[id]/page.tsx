import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BackToRadar } from "@/components/BackToRadar";
import { CopyAddress } from "@/components/CopyAddress";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { ClusterBadge } from "@/components/ClusterBadge";
import { IdlViewer } from "@/components/IdlViewer";
import { UsageSection } from "@/components/UsageSection";
import { ComputeSection } from "@/components/ComputeSection";
import { DossierTabs, type DossierTab } from "@/components/DossierTabs";
import { RecordTable, type Trail } from "@/components/RecordTable";
import { SignalHex } from "@/components/SignalHex";
import { Sparkline } from "@/components/Sparkline";
import { deriveSignals } from "@/lib/signals";
import { deriveComposition } from "@/lib/composition";
import { TIER_ORDER } from "@/lib/primitives";
import { deriveLifecycle, botKind, BOT_LABEL } from "@/lib/lifecycle";
import { OTHER_FRAMEWORKS_NOTE } from "@/lib/frameworks";
import { SectionExplainer } from "@/components/SectionExplainer";
import { BotExplainer } from "@/components/BotExplainer";
import { SectionHeader } from "@/components/SectionHeader";
import { SaveButton } from "@/components/SaveButton";
import { Lineage } from "@/components/Lineage";
import { ReachMap } from "@/components/Reach";
import {
  categoryLabel,
  fetchCluster,
  fetchIdl,
  fetchProgram,
  fetchUsage,
  fetchVersions,
  versionsBySlot,
  orbAddress,
  orbTx,
  type ApiProgramDetail,
  type ApiRawEvent,
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
// fill aligned with the lean/moderate/heavy/extra-heavy bands; true whales (4 MiB+)
// cap at full.
function sizeFillPct(bytes: number): number {
  const FLOOR = Math.log10(8 * 1024);
  const CEIL = Math.log10(4 * 1024 * 1024);
  const p = (Math.log10(bytes) - FLOOR) / (CEIL - FLOOR);
  return Math.max(3, Math.min(100, p * 100));
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
        program.framework && program.framework !== "unknown" ? `${program.framework}, ` : ""
      }${program.sizeBytes ? formatBytes(program.sizeBytes) : "size unknown"}${
        program.deployCostSol != null ? `, ${program.deployCostSol} SOL locked` : ""
      }. Novelty, control, activity & cost, decoded on-chain.`
    : "A Solana program on On Record — the novel-program radar for Solana.";
  return {
    title: label,
    description,
    // the file-convention og image is picked up automatically; the twitter
    // card type must be explicit or X falls back to a small summary tile
    twitter: { card: "summary_large_image" },
  };
}

/** one label/value row */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact-row">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{children}</span>
    </div>
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

/** One cluster's slice of the record: a heading that says which cluster and how
 *  that deployment stands, then its events.
 *
 *  A program id can hold a deployment on each cluster, and they have separate
 *  lives — different builds, different upgrade counts, often a hot key on devnet
 *  and a multisig on mainnet. Listing both in one table meant the only way to
 *  tell a devnet row from a mainnet one was to know that devnet runs tens of
 *  millions of slots ahead. */
function ClusterRecord({
  cluster,
  events,
  program,
  isPrimary,
  trail,
}: {
  cluster: string;
  events: ApiProgramDetail["events"];
  program: ApiProgramDetail;
  isPrimary: boolean;
  trail: Trail;
}) {
  const cp = program.counterpart;
  const upgrades = events.filter((e) => e.type === "upgrade").length;
  const last = events[0]?.blockTime ?? null;

  // The summary only states what this cluster's own evidence supports. On the
  // primary that is the profiled row; on the other side it is the probe, and
  // when there is no probe it says so rather than implying "live".
  const bits: string[] = [];
  if (isPrimary) {
    bits.push(program.closed ? "closed" : "live");
    if (program.authorityClass === "none") bits.push("immutable");
    else if (program.multisig?.threshold)
      bits.push(`squads ${program.multisig.threshold}/${program.multisig.members ?? "?"}`);
    else if (program.authorityClass) bits.push(program.authorityClass.replace("_", " "));
  } else if (cp?.network === cluster) {
    bits.push(cp.present ? (cp.alive === false ? "closed there" : "live") : "not deployed");
    if (cp.authorityClass) bits.push(cp.authorityClass.replace("_", " "));
  } else {
    bits.push("not probed");
  }
  if (upgrades > 0) bits.push(`${upgrades} upgrade${upgrades === 1 ? "" : "s"} on record`);
  if (last) bits.push(`last ${relativeTime(last)}`);

  return (
    <div className="cluster-record">
      <p className="cluster-record-head">
        <span className={`cluster-record-net cluster-record-net-${cluster}`}>on {cluster}</span>
        <span className="cell-dim"> · {bits.join(" · ")}</span>
      </p>
      <RecordTable events={events} trail={trail} />
    </div>
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ network?: string }>;
}) {
  const { id } = await params;
  const program = await fetchProgram(id);
  if (!program) notFound();

  // Make the url tell the truth about the cluster, then let the one banner in
  // the root layout read it. Rendering a second banner from inside the page
  // was the obvious fix and the wrong one: .page is a centred, padded column,
  // so that instance came out inset and pushed down while every other route's
  // sat flush and full-bleed. One banner, in one place, fed a URL that cannot
  // disagree with the subject.
  const urlNet = (await searchParams).network;
  if (program.network === "devnet" && urlNet !== "devnet") {
    redirect(`/p/${encodeURIComponent(id)}?network=devnet`);
  }
  if (program.network === "mainnet" && urlNet === "devnet") {
    redirect(`/p/${encodeURIComponent(id)}?network=mainnet`);
  }

  // The interface (IDL) + its real usage. Always ask rather than trusting
  // idlPresent: that flag is a snapshot taken once at ingest, and teams often
  // publish the IDL in a separate transaction AFTER deploying — so a program
  // that shipped one later stayed false forever and the tab confidently claimed
  // no IDL existed (horse-fun had 22 instructions published). The IDL endpoint
  // does a live on-chain lookup, so the flag buys nothing but staleness.
  const [idl, storedUsage, versions] = await Promise.all([
    fetchIdl(id),
    fetchUsage(id),
    fetchVersions(id),
  ]);
  const trail = versionsBySlot(versions);
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

  const trustPanel = (
    <>
      <SectionHeader title="Control" info="Who can change it — and whether it can rug." />
      <div className="facts-panel">
        <Row label="Mutability">{mutability}</Row>
        <Row label="Authority">
          {program.multisig ? (
            <>
              Squads multisig
              {program.multisig.threshold != null && program.multisig.members != null ? (
                <span> · {program.multisig.threshold} of {program.multisig.members} signers</span>
              ) : null}
              <Ext
                href={orbAddress(program.multisig.address)}
                text={truncateAddress(program.multisig.address)}
              />
            </>
          ) : (
            <>
              {program.authorityClass ?? "unknown"}
              {program.authority ? (
                <Ext href={orbAddress(program.authority)} text={truncateAddress(program.authority)} />
              ) : null}
            </>
          )}
        </Row>
        <Row label="Verified build">
          {program.verified ? (
            <>
              yes{" "}
              <span className="cell-dim">· bytecode reproduces from public source</span>
            </>
          ) : (
            <>
              no{" "}
              <span className="cell-dim">· source not confirmed against on-chain bytecode</span>
            </>
          )}
        </Row>
      </div>

      <SectionExplainer title="What's upgrade authority?">
        <p className="explainer-read">
          The upgrade authority is the account allowed to replace a
          program&apos;s code after it&apos;s deployed.
        </p>
        <p>
          If it&apos;s set (<strong>mutable</strong>), that key can push new
          bytecode at any time — including malicious code, the classic
          &quot;rug&quot; vector. If it&apos;s null (
          <strong>immutable / frozen</strong>), the code can never change; what
          &apos;s on-chain is final. A <strong>Squads multisig</strong> sits in
          between — upgrades are possible but need M-of-N signers, not one hot
          wallet. So mutable + single hot-wallet = highest risk; immutable or
          multisig = stronger guarantees.
        </p>
      </SectionExplainer>

      <SectionExplainer title="What's a verified build?">
        <p className="explainer-read">
          A verified build proves the program running on-chain was compiled from
          the public source you can read — nothing hidden.
        </p>
        <p>
          Someone re-compiles the source in a deterministic (Docker) environment
          and checks the resulting bytecode is byte-for-byte identical to
          what&apos;s deployed; tools like <strong>solana-verify</strong> do this
          and record it with a verification service.{" "}
          <strong>&quot;Not verified&quot; isn&apos;t a red flag by itself</strong>{" "}
          — most programs simply never submit one. It just means you&apos;re
          trusting the deployed bytecode as-is, with no source cross-check.
        </p>
      </SectionExplainer>
      {program.repoLink ? (
        <>
          <SectionHeader
            title="Source repo (found, not declared)"
            info="Nobody declared a repo for this program. This one was found by searching public code for the program id."
          />
          <div className="facts-panel">
            <Row label="Repo">
              <Ext href={program.repoLink.repoUrl} text={program.repoLink.repo} />
            </Row>
            <Row label="Match">
              {program.repoLink.method === "declared"
                ? "declares this program id as its own"
                : "carries the crate path the binary leaked"}
              {program.repoLink.crateConfirmed ? (
                <span className="cell-dim"> · crate path confirmed both ways</span>
              ) : null}
            </Row>
            <Row label="Evidence">
              {program.repoLink.matchCount} file
              {program.repoLink.matchCount === 1 ? "" : "s"} contain the address
              {program.repoLink.matchedPaths.length ? (
                <span className="cell-dim"> · {program.repoLink.matchedPaths.join(" · ")}</span>
              ) : null}
            </Row>
            {program.repoLink.otherCandidates > 0 ? (
              <Row label="Other candidates">
                {program.repoLink.otherCandidates} other repo
                {program.repoLink.otherCandidates === 1 ? "" : "s"} could claim this link
                <span className="cell-dim"> · copies, renames, hard forks</span>
              </Row>
            ) : null}
          </div>
          <SectionExplainer title="How was this found?">
            <p className="explainer-read">
              A program id is 32 bytes of entropy. A developer who publishes
              their source commits it verbatim — so searching public code for
              the address finds the repo the binary never names.
            </p>
            <p>
              It only counts when the link closes both ways: the binary leaks a
              crate path (<strong>programs/&lt;crate&gt;/src/…</strong>) and the
              repo carries that same path, or the repo declares this exact
              address as its own program.{" "}
              <strong>This is an inference, not a verified build</strong> —
              nobody re-compiled the source and matched the bytecode. Treat it
              as a lead with its evidence attached, and read the matched files
              yourself before trusting it.
            </p>
          </SectionExplainer>
        </>
      ) : null}
      {program.securityTxt ? (
        <>
          <SectionHeader
            title="Security.txt"
            info="Embedded in the binary by the developer — their own declaration, verbatim."
          />
          <div className="facts-panel">
            {program.securityTxt.project_url ? (
              <Row label="Project URL">
                {/^https?:\/\//.test(program.securityTxt.project_url) ? (
                  <Ext
                    href={program.securityTxt.project_url}
                    text={shortUrl(program.securityTxt.project_url)}
                  />
                ) : (
                  program.securityTxt.project_url
                )}
              </Row>
            ) : null}
            {program.securityTxt.contacts ? (
              <Row label="Contacts">{program.securityTxt.contacts}</Row>
            ) : null}
            {program.securityTxt.auditors ? (
              <Row label="Auditors">{program.securityTxt.auditors}</Row>
            ) : null}
            {program.securityTxt.policy ? (
              <Row label="Policy">
                {/^https?:\/\//.test(program.securityTxt.policy) ? (
                  <Ext href={program.securityTxt.policy} text={shortUrl(program.securityTxt.policy)} />
                ) : (
                  program.securityTxt.policy
                )}
              </Row>
            ) : null}
            {program.securityTxt.source_revision ? (
              <Row label="Source revision">
                <span className="cell-dim">{program.securityTxt.source_revision}</span>
              </Row>
            ) : null}
            {/* Declared source that doesn't resolve. Shown, because a broken
                on-chain pointer is a fact about the disclosure — but as text,
                never a link, and it is not counted as a repo anywhere else. */}
            {program.repoUrlDeclared ? (
              <Row label="Source code">
                <span className="cell-dim">{shortUrl(program.repoUrlDeclared)}</span>{" "}
                <span className="cell-dim">· declared, but the URL 404s</span>
              </Row>
            ) : null}
          </div>
          <SectionExplainer title="What's a security.txt?">
            <p className="explainer-read">
              A block of contact info a developer embeds directly in the program
              binary — the Neodyme convention — so whitehats know how to report a
              vulnerability.
            </p>
            <p>
              It carries contacts, a disclosure policy, auditors, and a source
              link. It&apos;s self-declared, so treat it as a claim, not proof —
              but its presence signals a team that expects scrutiny and wants to
              be reachable.
            </p>
          </SectionExplainer>
        </>
      ) : null}
      <SectionHeader title="Conviction" info="Skin in the game — who funded the deployer and how." />
      <div className="facts-panel">
        <Row label="Deployer funded by">
          {program.funderAddress ? (
            <>
              <Ext
                href={orbAddress(program.funderAddress)}
                text={truncateAddress(program.funderAddress)}
              />
              {program.deployerFundingSource && program.deployerFundingSource !== "unknown" ? (
                <span className="cell-dim"> · {program.deployerFundingSource}</span>
              ) : null}
            </>
          ) : program.deployerFundingSource ? (
            program.deployerFundingSource
          ) : (
            <span className="cell-dim">untraced</span>
          )}
          {program.fundingAmountSol != null ? (
            <span className="cell-dim"> · {program.fundingAmountSol} SOL</span>
          ) : null}
        </Row>
        <Row label="Deploy cost">
          {program.deployCostSol != null ? (
            <>
              ≈ {program.deployCostSol} SOL{" "}
              <span className="cell-dim">rent locked on-chain</span>
            </>
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
      </div>
    </>
  );

  const comp = deriveComposition(program);
  const lifecycle = deriveLifecycle(program);
  const botClass = botKind(program); // 'sniper' | 'throwaway' | 'duplicate' | null
  const SIZE_BAND_LABEL: Record<string, string> = {
    lean: "lean",
    moderate: "moderate",
    heavy: "heavy",
  };

  const compositionPanel = (
    <>
      {/* MATCH is a measurement, so it mostly explains itself. This says what
          is being measured, and covers the two cases where a word appears in
          place of a figure. */}
      <SectionHeader
        title="Lineage"
        info="Every program built from this code, oldest first. MATCH is how much of the compiled bytecode is the same as this program's — 100% is the same image under a different address. LOOKALIKE means the resemblance is generic enough to mean nothing, so no figure is given. SAME SOURCE means the two share a source tree recovered from panic paths in the binary, but the builds are too far apart in size to score."
      />
      <Lineage program={program} family={family} />

      <SectionHeader
        title="Framework"
        info="Read off the ELF — the syscall ABI and marker strings. Confidence: 'confirmed' = provable on-chain (Anchor); 'inferred' = read from binary shape. New to a framework? Expand the explainer at the bottom of this tab."
      />
      <div className="fw-stat">
        <span className="fw-stat-value">{comp.framework.label}</span>
        <span
          className={`fw-conf fw-conf-${comp.confidence}`}
          title={comp.framework.detection}
        >
          {comp.confidence}
        </span>
        {comp.publishesIdl ? (
          <span className="fw-tag" title="Ships an on-chain Anchor IDL — the program describes itself">
            self-describing IDL
          </span>
        ) : null}
        <span className="fw-pos">{comp.framework.positioning}</span>
      </div>

      <SectionExplainer title={`What's ${comp.framework.label}?`}>
        <p className="explainer-read">{comp.framework.read}</p>
        <p className="explainer-tradeoff">{comp.framework.tradeoff}</p>
        <p className="explainer-lead">{comp.framework.explainer.author}</p>

        <h4 className="explainer-h">What it is</h4>
        <p>{comp.framework.explainer.whatIs}</p>

        <h4 className="explainer-h">When to pick it</h4>
        <p>{comp.framework.explainer.whenToPick}</p>

        <h4 className="explainer-h">How it looks on-chain</h4>
        <p>{comp.framework.explainer.onChain}</p>

        <p className="explainer-note">{OTHER_FRAMEWORKS_NOTE}</p>

        {comp.framework.explainer.docsUrl ? (
          <a
            className="explainer-docs"
            href={comp.framework.explainer.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {comp.framework.label} docs
            <span aria-hidden="true"> ↗</span>
          </a>
        ) : null}
      </SectionExplainer>

      <SectionHeader
        title="Footprint"
        info="The physical cost of the build — what the framework choice put on-chain."
      />
      <div className="comp-metrics">
        <div className="comp-metric">
          <span className="comp-metric-v">{formatBytes(comp.sizeBytes)}</span>
          <span className="comp-metric-k">
            image size
            {comp.sizeBand ? (
              <span className={`size-band size-band-${comp.sizeBand}`}>
                {" "}· {SIZE_BAND_LABEL[comp.sizeBand]}
              </span>
            ) : null}
          </span>
          {comp.sizeBytes != null ? (
            <div className="fp-track">
              <div
                className={`fp-fill size-fill-${comp.sizeBand ?? "moderate"}`}
                style={{ width: `${sizeFillPct(comp.sizeBytes)}%` }}
              />
            </div>
          ) : null}
        </div>
        <div className="comp-metric">
          <span className="comp-metric-v">
            {comp.rentSol != null ? `${comp.rentSol} SOL` : "—"}
          </span>
          <span className="comp-metric-k">rent locked</span>
        </div>
        <div className="comp-metric">
          <span className="comp-metric-v">{comp.syscallCount ?? "—"}</span>
          <span className="comp-metric-k">syscalls imported</span>
        </div>
        <div className="comp-metric">
          <span className="comp-metric-v">
            {comp.instructions.length ||
              (program.instructionCount != null ? program.instructionCount : "—")}
          </span>
          <span className="comp-metric-k">instructions</span>
        </div>
      </div>
      {comp.primitives.items.length ? (
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
      ) : null}

      {/* Footprint is what the build put on-chain; this is what a call costs to
          run. Same tab, next section — the runtime half of the same question. */}
      <SectionHeader
        title="Compute per transaction"
        info="What one transaction touching this program burns, and what it reserved. Sampled and parsed, never counted."
      />
      <ComputeSection
        programId={program.id}
        initialCompute={program.compute ?? null}
        initialRank={program.computeRank ?? null}
      />

      {comp.crate || comp.moduleGroups.length || comp.instructions.length ? (
        <>
          <SectionHeader
            title="Recovered architecture"
            info="The developer's own Rust source structure, recovered from panic paths and symbols left in the binary. Rust standard-library paths are filtered out."
          />
          <div className="facts-panel">
            {comp.crate ? (
              <Row label="Crate">
                <span className="crate-name">{comp.crate}</span>
              </Row>
            ) : null}
            {comp.instructions.length ? (
              <Row label={comp.instructionsApprox ? "Instructions ~" : "Instructions"}>
                <span className="chip-inline">
                  {comp.instructions.map((ix) => (
                    <span className="mod-chip" key={ix}>
                      {ix}
                    </span>
                  ))}
                </span>
              </Row>
            ) : null}
            {comp.toolchain || comp.deps.length ? (
              <Row label="Built with">
                {comp.deps.length ? (
                  <span className="chip-inline">
                    {comp.deps.map((d) => (
                      <span className="dep-chip" key={d}>
                        {d}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="cell-dim">solana toolchain</span>
                )}
              </Row>
            ) : null}
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
        </>
      ) : null}

      <SectionHeader
        title="Reach"
        info="What it plugs into. Embedded = a program id found verbatim in the bytecode (confirmed). Named in source = a protocol named in the recovered source paths (strong hint, confirmable against the live CPI graph)."
      />
      <div className="facts-panel">
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
            <span className="cell-dim">no known program id embedded</span>
          )}
        </Row>
        {comp.sourceReach.length ? (
          <Row label="Named in source">
            <span className="chip-inline">
              {comp.sourceReach.map((it) => (
                <span className="ix-chip ix-chip-soft" key={it}>
                  {it}
                </span>
              ))}
            </span>
          </Row>
        ) : null}
      </div>
    </>
  );

  const activityPanel = (
    <>
      <UsageSection
        programId={program.id}
        initialUsage={usage}
        initialSampledAt={usageSampledAt}
        compact
      />
      <SectionHeader title="Traction" info="Does it actually get used? Accrues over time." />
      <div className="facts-panel">
        {program.momentum ? (
          <Row label="Last 24h">
            {program.momentum.txns24h.toLocaleString("en-US")}
            {program.momentum.txns24hTruncated ? "+" : ""} txns
            {program.momentum.growth != null ? (
              <span className="cell-dim"> · ×{program.momentum.growth} vs prior day</span>
            ) : null}
          </Row>
        ) : null}
        {program.activity && program.activity.length >= 2 ? (
          <Row label="Activity (7d)">
            <Sparkline
              points={program.activity}
              title="hourly transactions, last 7 days"
            />
          </Row>
        ) : null}
        <Row label="Early activity">
          {program.earlySigners != null ? (
            `${program.earlySigners >= 1000 && program.earlySigners % 1000 === 0 ? `${program.earlySigners.toLocaleString("en-US")}+` : program.earlySigners.toLocaleString("en-US")} txns in the first 24h`
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
      </div>
      {primaryEvents.length > 0 || otherEvents.length > 0 ? (
        <>
          <SectionHeader
            title="The record"
            info="Every loader event on this program id — deploy, upgrade, authority change, close — with the transaction that proves it. The same program id can be deployed to both clusters, so each cluster's history is listed separately. Related programs live under Lineage."
          />
          <ClusterRecord
            cluster={program.network}
            events={primaryEvents}
            program={program}
            isPrimary
            trail={trail}
          />
          {otherEvents.length > 0 ? (
            <ClusterRecord
              cluster={otherCluster}
              events={otherEvents}
              program={program}
              isPrimary={false}
              trail={trail}
            />
          ) : null}
        </>
      ) : null}
    </>
  );

  const idlExplainer = (
    <SectionExplainer title="What's an IDL?">
      <p className="explainer-read">
        An <strong>IDL</strong> — Interface Description Language — is a JSON spec
        that describes how to talk to a program: its instructions, the accounts
        each one needs, argument and account types, events, and errors.
      </p>
      <p className="explainer-tradeoff">
        Anchor auto-generates it at build time. A program can publish it
        on-chain at a PDA derived from its id, so any client or explorer can
        decode the program&apos;s transactions without its source code.
      </p>
      <h4 className="explainer-h">Why it&apos;s often missing</h4>
      <p>
        Publishing is opt-in — a courtesy, not a requirement. Many programs
        never do, and non-Anchor frameworks (Pinocchio, native, Steel)
        don&apos;t produce one at all; their interface lives in an off-chain
        Shank/Codama artifact, or nowhere public. Absence means you can&apos;t
        auto-decode it — not that anything is wrong.
      </p>
    </SectionExplainer>
  );

  const interfacePanel = idl ? (
    <>
      <SectionHeader
        title="Interface — the on-chain IDL"
        info="The program's published IDL: every instruction, its accounts, and its types. This is what lets a client decode the program without its source."
      />
      <UsageSection programId={program.id} initialUsage={usage} initialSampledAt={usageSampledAt} />
      <IdlViewer idl={idl} />
      {idlExplainer}
    </>
  ) : (
    <>
      <SectionHeader
        title="No IDL published"
        info="An IDL (Interface Description Language) is the JSON that names a program's instructions, accounts, and types so a client can decode it without the source."
      />
      <div className="no-idl">
        <p className="no-idl-lead">
          This program hasn&apos;t published an <strong>IDL</strong> — the
          interface spec that would let its instructions be auto-decoded here.
        </p>
        <p>
          <strong>That&apos;s normal, not a red flag.</strong> Publishing an IDL
          on-chain is opt-in — closer to a courtesy than a requirement. Anchor
          can write one to a PDA derived from the program id, but plenty of
          teams never do. And non-Anchor programs —{" "}
          {comp.framework.key === "anchor" ? "Pinocchio, native, Steel" : `like this ${comp.framework.label} one`}{" "}
          — have no built-in IDL at all; their interface lives in an off-chain
          Shank/Codama artifact, or nowhere public.
        </p>
        {comp.instructions.length ? (
          <p>
            We still recovered{" "}
            <strong>{comp.instructions.length} instruction handler(s)</strong>{" "}
            straight from the binary — see the{" "}
            <span className="no-idl-ptr">Composition</span> tab. That&apos;s the
            on-chain-first answer to a missing IDL: read the program, not its
            paperwork.
          </p>
        ) : null}
      </div>
      {idlExplainer}
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
        info="Which programs reach for this one, and which it reaches for. Each arrow is a program id compiled into the binary at its tail — a reference, not a proven call."
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

  const tabs: DossierTab[] = [
    { id: "composition", label: "Composition", panel: compositionPanel },
    { id: "trust", label: "Trust", panel: trustPanel },
    { id: "interface", label: "Interface", panel: interfacePanel, muted: !idl },
    // muted, not hidden: an empty map means "nothing on record names this",
    // which is a real answer, and hiding the tab would make the extraction look
    // broken on the programs it simply found nothing for.
    { id: "map", label: "Map", panel: mapPanel, muted: reachCount === 0 },
    { id: "activity", label: "Activity", panel: activityPanel },
  ];

  return (
    <>
      <BackToRadar fallbackHref={program.network === "devnet" ? "/?network=devnet" : "/"} />

      <div className="dossier-head">
        <div className="dossier-head-main">
          <div className="dossier-band-line">
            <span className={`cat-chip cat-${program.category}`}>
              {categoryLabel(program.category)}
            </span>
            {program.framework && program.framework !== "unknown" ? (
              <span className="fw-chip">{program.framework}</span>
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
          </div>

          <div className="dossier-title-row">
            <ProgramAvatar program={program} size={38} />
            <h1 className="dossier-title">
              {program.name ?? (
                <span className="dossier-title-unknown">Unidentified program</span>
              )}
              {program.verified ? <VerifiedBadge size={19} /> : null}
            </h1>
          </div>

          <div className="dossier-sub">
            <CopyAddress value={program.id} display={program.id} className="dossier-id" />
            <span className="dossier-links">
              <IconLink href={orbAddress(program.id)} label="Open in Orb explorer">
                <OrbIcon />
              </IconLink>
              {program.repoUrl ? (
                <IconLink href={program.repoUrl} label="Source code">
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
            if (!first) return null;
            const cluster = program.network === "devnet" ? "devnet" : "mainnet";
            const verb = program.firstDeployAt != null ? "First deployed on" : "First seen on";
            return (
              <div className="dossier-deployed" title={`${verb} ${cluster} · ${relativeTime(first)}`}>
                <CalendarIcon />
                <span className="dossier-deployed-date">{dayStamp(first)}</span>
                <ClusterBadge program={program} />
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
