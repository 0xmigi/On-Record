import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyAddress } from "@/components/CopyAddress";
import { SectionHeader } from "@/components/SectionHeader";
import {
  CATEGORY_LABELS,
  fetchProgram,
  orbAddress,
  orbTx,
  type ApiProgramDetail,
  type ApiRawEvent,
} from "@/lib/api";
import {
  formatBytes,
  noveltyGauge,
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

  const gauge = noveltyGauge(program.noveltyScore);
  const mutability =
    program.authorityClass === "none"
      ? "immutable (frozen)"
      : program.authorityClass
        ? "mutable"
        : "unknown";

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
            <span className="net-chip">{program.network}</span>
          </div>

          <h1 className="dossier-addr">
            <CopyAddress value={program.id} display={program.id} />
          </h1>

          <div className="dossier-sub">
            {program.name ? (
              <span className="dossier-name">{program.name}</span>
            ) : (
              <span className="dossier-name dossier-name-unknown">
                unidentified program
              </span>
            )}
            <Ext href={orbAddress(program.id)} text="open in Orb" />
          </div>
        </div>

        <div
          className="dossier-gauge"
          title={`novelty ${program.noveltyScore.toFixed(2)}`}
        >
          <span className="gauge-num">{gauge}</span>
          <span className="gauge-label">novelty</span>
        </div>
      </div>

      <p className="dossier-note">
        Vectors 1–5 are read straight from the binary the moment it deployed.
        Traction (6) accrues over time.
      </p>

      {/* 1 · IDENTITY */}
      <SectionHeader title="1 · Identity" info="What it is and who made it." />
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

      {/* 2 · LINEAGE */}
      <SectionHeader
        title="2 · Lineage"
        info="Is it new code, or derived from something known? Novelty = 1 − similarity to the nearest program on record."
      />
      <div className="facts-panel">
        <Row label="Novelty">{gauge} / 100</Row>
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
                {" "}
                · {Math.round(program.nearest.similarity * 100)}% code match
              </span>
            </>
          ) : (
            <span className="cell-dim">no known relative — novel code</span>
          )}
        </Row>
      </div>

      {/* 3 · COMPOSITION */}
      <SectionHeader
        title="3 · Composition"
        info="What it's built with and plugs into — parsed from the ELF binary."
      />
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

      {/* 4 · CONTROL */}
      <SectionHeader
        title="4 · Control"
        info="Who can change it — and whether it can rug."
      />
      <div className="facts-panel">
        <Row label="Mutability">{mutability}</Row>
        <Row label="Authority">
          {program.authorityClass ?? "unknown"}
          {program.authority ? (
            <Ext href={orbAddress(program.authority)} text={truncateAddress(program.authority)} />
          ) : null}
        </Row>
        <Row label="Verified build">{program.verified ? "yes" : "no"}</Row>
      </div>

      {/* 5 · CONVICTION */}
      <SectionHeader
        title="5 · Conviction"
        info="Skin in the game — who funded the deployer and how."
      />
      <div className="facts-panel">
        <Row label="Deployer funded by">
          {program.deployerFundingSource ? (
            program.deployerFundingSource
          ) : program.funderAddress ? (
            <Ext href={orbAddress(program.funderAddress)} text={truncateAddress(program.funderAddress)} />
          ) : (
            <span className="cell-dim">untraced</span>
          )}
          {program.fundingAmountSol != null ? (
            <span className="cell-dim"> · {program.fundingAmountSol} SOL</span>
          ) : null}
        </Row>
      </div>

      {/* 6 · TRACTION — accrues over time */}
      <SectionHeader
        title="6 · Traction"
        info="Does it actually get used? This is the only vector that isn't knowable at deploy — it accrues over time."
      />
      <div className="facts-panel">
        <Row label="Early activity">
          {program.earlySigners != null ? (
            `${program.earlySigners} txns in first window`
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
                    <span className={`evt-tag evt-${ev.type}`}>
                      {EVENT_LABELS[ev.type]}
                    </span>
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
}
