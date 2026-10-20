import Link from "next/link";
import { BackToRadar } from "@/components/BackToRadar";
import { CopyAddress } from "@/components/CopyAddress";
import { RecordTable } from "@/components/RecordTable";
import { SectionHeader } from "@/components/SectionHeader";
import { builderHref, orbAddress, type ApiArchiveDetail, type VersionTrail } from "@/lib/api";
import { dayStamp, truncateAddress } from "@/lib/format";

/**
 * A program On Record never saw live, rendered from the archive alone: the Old
 * Faithful backfill's loader record and rebuilt versions. Everything shown is
 * read from that record — no live chain state, no score, no usage — and the
 * page says where the record ends rather than implying it is complete.
 */
export function ArchivedProgram({ program, trail }: { program: ApiArchiveDetail; trail: VersionTrail }) {
  const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
  const cells: { k: string; v: React.ReactNode; tip: string }[] = [
    { k: "Status", v: program.closedAt ? `closed ${dayStamp(program.closedAt)}` : "not closed in the archive", tip: "Whether a Close instruction removed this program's ProgramData inside the archive's range" },
    { k: "Framework", v: program.framework === "unknown" ? "—" : program.framework, tip: "Read from the latest version's bytecode" },
    { k: "Versions", v: String(program.versions), tip: "Deploys and upgrades in the archive, each rebuilt from its buffer's writes" },
    { k: "Size", v: program.sizeBytes ? fmtBytes(program.sizeBytes) : "—", tip: "The latest version's bytecode" },
    { k: "Crate", v: program.crate ?? "—", tip: "The Rust crate name recovered from the binary's panic paths" },
    { k: "Instructions", v: program.instructionNames.length ? String(program.instructionNames.length) : "—", tip: "Handler names recovered from the latest version's bytecode" },
    { k: "Upgrades", v: String(program.upgrades), tip: "Upgrades in the archive's range" },
    {
      k: "Authority",
      v: program.authority ? (
        <Link className="receipt-link" prefetch={false} href={builderHref(program.authority, "mainnet")}>
          {truncateAddress(program.authority)}
        </Link>
      ) : (
        "—"
      ),
      tip: "The upgrade authority on the latest deploy or upgrade in the archive",
    },
  ];

  return (
    <>
      <BackToRadar fallbackHref="/" />
      <div className="dossier-head">
        <div className="dossier-head-main">
          <div className="dossier-band-line">
            {program.closedAt ? <span className="closed-chip">closed</span> : null}
            <span className="cluster-note">from the archive</span>
          </div>
          <div className="dossier-title-row">
            <h1 className="dossier-title">
              {program.name ?? program.crate ?? <span className="dossier-title-unknown">Unidentified program</span>}
            </h1>
          </div>
          <div className="dossier-sub">
            <CopyAddress value={program.id} display={program.id} className="dossier-id" />
            <span className="dossier-links">
              <a className="icon-link" href={orbAddress(program.id)} target="_blank" rel="noopener noreferrer" title="Open in Orb explorer">
                ↗
              </a>
            </span>
          </div>
          {program.firstDeployAt || program.deployer ? (
            <div className="dossier-deployed">
              {program.firstDeployAt ? (
                <span className="dossier-deployed-when" title="First deployed on mainnet">
                  <span className="dossier-deployed-date">{dayStamp(program.firstDeployAt)}</span>
                </span>
              ) : null}
              {program.deployer ? (
                <span className="dossier-deployer">
                  <span className="dossier-deployer-k">deployer</span>
                  <Link className="receipt-link" prefetch={false} href={builderHref(program.deployer, "mainnet")}>
                    {truncateAddress(program.deployer)}
                  </Link>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="ov-grid">
        {cells.map((c) => (
          <div className="ov-cell" key={c.k}>
            <span className="ov-k tip" data-tip={c.tip} tabIndex={0}>
              {c.k}
            </span>
            <span className="ov-v">{c.v}</span>
          </div>
        ))}
      </div>

      <SectionHeader
        title="Deploys and upgrades"
        info="Every loader event on this program id from 18 Jul 2023 to 13 Oct 2026, read from the Old Faithful archive, each with the transaction that proves it. On Record never saw this program live, so nothing after that range is on record."
      />
      <RecordTable events={program.events} trail={trail} />
    </>
  );
}
