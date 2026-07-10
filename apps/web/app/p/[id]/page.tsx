import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyAddress } from "@/components/CopyAddress";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { IdlViewer } from "@/components/IdlViewer";
import { UsageBars } from "@/components/UsageBars";
import { DossierTabs, type DossierTab } from "@/components/DossierTabs";
import { SignalHex } from "@/components/SignalHex";
import { Sparkline } from "@/components/Sparkline";
import { deriveSignals } from "@/lib/signals";
import { deriveComposition } from "@/lib/composition";
import { deriveLifecycle } from "@/lib/lifecycle";
import { OTHER_FRAMEWORKS_NOTE } from "@/lib/frameworks";
import { SectionExplainer } from "@/components/SectionExplainer";
import { SectionHeader } from "@/components/SectionHeader";
import {
  CATEGORY_LABELS,
  fetchIdl,
  fetchProgram,
  fetchUsage,
  orbAddress,
  orbTx,
  type ApiProgramDetail,
  type ApiRawEvent,
} from "@/lib/api";
import { formatBytes, relativeTime, shortUrl, truncateAddress } from "@/lib/format";

const EVENT_LABELS: Record<ApiRawEvent["type"], string> = {
  deploy: "DEPLOY",
  upgrade: "UPGRADE",
  set_authority: "SET AUTHORITY",
  close: "CLOSE",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const program = await fetchProgram(id);
  const label = program?.name ?? truncateAddress(id);
  return { title: `${label} — dossier` };
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

export default async function ProgramDossierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const program = await fetchProgram(id);
  if (!program) notFound();

  // the interface (IDL) + its real usage — only when the program ships an IDL
  const [idl, usage] = program.idlPresent
    ? await Promise.all([fetchIdl(id), fetchUsage(id)])
    : [null, null];

  const mutability =
    program.authorityClass === "none"
      ? "immutable (frozen)"
      : program.authorityClass
        ? "mutable"
        : "unknown";

  const overviewPanel = (
    <>
      {usage && usage.instructions.length ? (
        <div style={{ marginBottom: 6 }}>
          <UsageBars usage={usage} compact />
        </div>
      ) : null}
      <SectionHeader title="Identity" info="What it is and who made it." />
      <div className="facts-panel">
        <Row label="Name">
          {program.name ?? <span className="cell-dim">unidentified</span>}
        </Row>
        <Row label="Category">{CATEGORY_LABELS[program.category]}</Row>
        <Row label="Source">
          {program.repoUrl ? (
            <Ext href={program.repoUrl} text={shortUrl(program.repoUrl)} />
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
        <Row label="Social">
          {program.social ? (
            <Ext href={program.social} text={shortUrl(program.social)} />
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
        <Row label="Website">
          {program.website ? (
            <Ext href={program.website} text={shortUrl(program.website)} />
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
      </div>
      <SectionHeader title="Lineage" info="Is it new code, or derived from something known?" />
      <div className="facts-panel">
        {program.codeMatch ? (
          <Row label="Exact code match">
            <Link href={`/p/${program.codeMatch.programId}`} className="neighbor-addr">
              {truncateAddress(program.codeMatch.programId)}
            </Link>
            <span className="cell-dim"> · byte-identical to </span>
            <Ext href={program.codeMatch.repository} text={shortUrl(program.codeMatch.repository)} />
          </Row>
        ) : null}
        <Row label="Nearest known program">
          {program.nearest ? (
            <>
              {program.nearest.isReference ? (
                <span className="dossier-name">{program.nearest.name}</span>
              ) : program.nearest.id ? (
                <Link href={`/p/${program.nearest.id}`} className="neighbor-addr">
                  {program.nearest.name ?? truncateAddress(program.nearest.id)}
                </Link>
              ) : (
                "a peer deploy"
              )}
              <span className="cell-dim">
                {" "}· {Math.round(program.nearest.similarity * 100)}% code match
              </span>
            </>
          ) : (
            <span className="cell-dim">no known relative — novel code</span>
          )}
        </Row>
      </div>
    </>
  );

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
      {program.securityTxt ? (
        <>
          <SectionHeader
            title="Security.txt"
            info="Embedded in the binary by the developer — their own declaration, verbatim."
          />
          <div className="facts-panel">
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
  const SIZE_BAND_LABEL: Record<string, string> = {
    lean: "lean",
    moderate: "moderate",
    heavy: "heavy",
  };

  const compositionPanel = (
    <>
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
      {comp.capabilities.length ? (
        <div className="facts-panel" style={{ marginTop: 8 }}>
          <Row label="Capabilities">
            <span className="chip-inline">
              {comp.capabilities.map((c) => (
                <span className="ix-chip" key={c}>
                  {c}
                </span>
              ))}
            </span>
          </Row>
        </div>
      ) : null}

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
      <SectionHeader title="Traction" info="Does it actually get used? Accrues over time." />
      <div className="facts-panel">
        {program.momentum ? (
          <Row label="Last 24h">
            {program.momentum.txns24h.toLocaleString("en-US")} txns
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
      {program.events.length > 0 ? (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="record-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">When</th>
                <th scope="col">Slot</th>
                <th scope="col">Signature</th>
              </tr>
            </thead>
            <tbody>
              {program.events.map((ev) => (
                <tr key={ev.id}>
                  <td>
                    <span className={`evt-tag evt-${ev.type}`}>{EVENT_LABELS[ev.type]}</span>
                  </td>
                  <td className="cell-dim">
                    {ev.blockTime ? relativeTime(ev.blockTime) : "—"}
                  </td>
                  <td>{ev.slot.toLocaleString("en-US")}</td>
                  <td>
                    <Ext href={orbTx(ev.signature)} text={truncateAddress(ev.signature)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      {usage && usage.instructions.length ? (
        <div style={{ marginBottom: 18 }}>
          <UsageBars usage={usage} />
        </div>
      ) : null}
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

  const tabs: DossierTab[] = [
    { id: "overview", label: "Overview", panel: overviewPanel },
    { id: "trust", label: "Trust", panel: trustPanel },
    { id: "composition", label: "Composition", panel: compositionPanel },
    { id: "interface", label: "Interface", panel: interfacePanel, muted: !idl },
    { id: "activity", label: "Activity", panel: activityPanel },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        ← the radar
      </Link>

      <div className="dossier-head">
        <div className="dossier-head-main">
          <div className="dossier-band-line">
            <span className={`cat-chip cat-${program.category}`}>
              {CATEGORY_LABELS[program.category]}
            </span>
            {program.framework && program.framework !== "unknown" ? (
              <span className="fw-chip">{program.framework}</span>
            ) : null}
            {program.deployType === "upgrade" && program.upgradeCount > 0 ? (
              <span className="cluster-note">upgraded ×{program.upgradeCount}</span>
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
            </h1>
          </div>

          <div className="dossier-sub">
            <CopyAddress value={program.id} display={program.id} className="dossier-id" />
            <Ext href={orbAddress(program.id)} text="open in Orb" />
          </div>
        </div>
        <div className="dossier-head-signals">
          <SignalHex signals={deriveSignals(program)} size={140} labels />
        </div>
      </div>

      {lifecycle.ephemeral ? (
        <div className="churn-note">
          <span className="churn-note-tag">churn pattern</span>
          <p>
            Deployed and <strong>closed within {lifecycle.lifespanLabel ?? "minutes"}</strong>
            {program.earlySigners
              ? <> after <strong>{program.earlySigners.toLocaleString("en-US")}{program.earlySigners % 1000 === 0 ? "+" : ""} transactions</strong></>
              : null}
            {program.band === "clone"
              ? <> — and its bytecode is byte-identical to other deploys on record.</>
              : "."}{" "}
            This is the signature of a throwaway bot: deploy a fresh program id,
            run it hot, then close it to reclaim the rent — and repeat.
          </p>
        </div>
      ) : null}

      <DossierTabs tabs={tabs} />
    </>
  );
}
