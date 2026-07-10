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
        <Row label="Verified build">{program.verified ? "yes" : "no"}</Row>
      </div>
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

  const compositionPanel = (
    <>
      <SectionHeader title="Composition" info="What it's built with and plugs into — parsed from the ELF binary." />
      <div className="facts-panel">
        <Row label="Framework">{program.framework ?? "unknown"}</Row>
        <Row label="Plugs into">
          {program.integrations.length ? (
            <span className="chip-inline">
              {program.integrations.map((it) => (
                <span className="ix-chip" key={it}>
                  {it}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">nothing known detected</span>
          )}
        </Row>
        <Row label="Capabilities">
          {program.capabilities.length ? (
            <span className="chip-inline">
              {program.capabilities.map((c) => (
                <span className="ix-chip" key={c}>
                  {c}
                </span>
              ))}
            </span>
          ) : (
            <span className="cell-dim">—</span>
          )}
        </Row>
        <Row label="Instructions">
          {program.instructionCount != null
            ? program.instructionCount
            : program.idlPresent
              ? "IDL published"
              : "—"}
        </Row>
        <Row label="Syscalls imported">{program.syscallCount ?? "—"}</Row>
        <Row label="Image size">{formatBytes(program.sizeBytes)}</Row>
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

  const tabs: DossierTab[] = [
    { id: "overview", label: "Overview", panel: overviewPanel },
    { id: "trust", label: "Trust", panel: trustPanel },
    { id: "composition", label: "Composition", panel: compositionPanel },
    ...(idl
      ? [
          {
            id: "interface",
            label: "Interface",
            panel: (
              <>
                {usage && usage.instructions.length ? (
                  <div style={{ marginBottom: 18 }}>
                    <UsageBars usage={usage} />
                  </div>
                ) : null}
                <IdlViewer idl={idl} />
              </>
            ),
          },
        ]
      : []),
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

      <DossierTabs tabs={tabs} />
    </>
  );
}
