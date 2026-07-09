import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { CATEGORY_LABELS, orbAddress, type ApiProgram } from "@/lib/api";
import { formatBytes, noveltyGauge, relativeTime, truncateAddress } from "@/lib/format";

const AUTHORITY_LABELS: Record<NonNullable<ApiProgram["authorityClass"]>, string> = {
  none: "immutable",
  squads: "squads multisig",
  program: "program-owned",
  hot_wallet: "hot wallet",
};

function authorityLabel(cls: ApiProgram["authorityClass"]): string {
  return cls ? AUTHORITY_LABELS[cls] : "unknown authority";
}

/** Best URL to source a favicon from: an explicit website, else a github/x link. */
function faviconUrl(program: ApiProgram): string | null {
  const src = program.website ?? program.social ?? program.repoUrl;
  if (!src) return null;
  try {
    const host = new URL(src).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  } catch {
    return null;
  }
}

/** One fact chip in the compact facts row — label muted, value inked. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="radar-fact">
      <span className="radar-fact-k">{label}</span>
      <span className="radar-fact-v">{value}</span>
    </span>
  );
}

/**
 * One radar row. Leads with the program address (mono, copyable, links to the
 * dossier), then slot/time, then the raw facts, then a novelty gauge. Cluster
 * rows note "×N in cluster".
 */
export function ProgramRow({ program }: { program: ApiProgram }) {
  const gauge = noveltyGauge(program.noveltyScore);
  const inCluster = (program.clusterSize ?? 0) > 1;
  const favicon = faviconUrl(program);

  return (
    <article className="radar-row">
      <Link
        className="radar-row-link"
        href={`/p/${program.id}`}
        aria-label={`Open ${program.name ?? truncateAddress(program.id)}`}
      />
      <div className="radar-main">
        <div className={`radar-id-line${program.name ? " has-name" : ""}`}>
          {favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="radar-favicon" src={favicon} alt="" width={18} height={18} loading="lazy" />
          ) : (
            <span className="radar-favicon radar-avatar" aria-hidden="true">
              {program.id.slice(0, 2)}
            </span>
          )}
          {program.name ? (
            <span className="radar-name">{program.name}</span>
          ) : null}
          <CopyAddress
            value={program.id}
            display={truncateAddress(program.id)}
            href={`/p/${program.id}`}
            className="radar-addr"
          />
          {program.website ? (
            <a
              className="id-link"
              href={program.website}
              target="_blank"
              rel="noopener noreferrer"
              title={program.website}
            >
              site ↗
            </a>
          ) : null}
          {program.repoUrl ? (
            <a
              className="id-link"
              href={program.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={program.repoUrl}
            >
              github ↗
            </a>
          ) : null}
          {program.social ? (
            <a
              className="id-link"
              href={program.social}
              target="_blank"
              rel="noopener noreferrer"
              title={program.social}
            >
              x ↗
            </a>
          ) : null}
          {program.upgradeCount > 0 ? (
            <span className="cluster-note" title="Times this program has been re-deployed">
              upgraded ×{program.upgradeCount}
            </span>
          ) : null}
          {program.hasSecurityTxt ? (
            <span className="sec-badge" title="Embeds a security.txt in its binary">
              security.txt
            </span>
          ) : null}
          {program.verified ? (
            <span className="verified-check" title="Verified build">
              ✓ verified
            </span>
          ) : null}
          {inCluster ? (
            <span className="cluster-note">×{program.clusterSize} in cluster</span>
          ) : null}
        </div>

        <div className="radar-sub">
          <span>deployed {relativeTime(program.deployedAt)}</span>
          {program.deployedSlot != null ? (
            <>
              <span className="radar-dot">·</span>
              <a
                className="radar-slot"
                href={orbAddress(program.id)}
                target="_blank"
                rel="noopener noreferrer"
              >
                slot {program.deployedSlot.toLocaleString("en-US")}
              </a>
            </>
          ) : null}
        </div>

        <div className="radar-facts">
          <span className={`cat-chip cat-${program.category}`}>
            {CATEGORY_LABELS[program.category]}
          </span>
          {program.framework && program.framework !== "unknown" ? (
            <span className="fw-chip">{program.framework}</span>
          ) : null}
          {program.integrations.length > 0 ? (
            <Fact label="uses" value={program.integrations.slice(0, 2).join(", ")} />
          ) : null}
          {program.nearest?.isReference && program.nearest.similarity >= 0.4 ? (
            <Fact
              label="resembles"
              value={`${program.nearest.name} ${Math.round(program.nearest.similarity * 100)}%`}
            />
          ) : null}
          <Fact label="size" value={formatBytes(program.sizeBytes)} />
          <Fact
            label="ix"
            value={
              program.instructionCount != null
                ? String(program.instructionCount)
                : program.idlPresent
                  ? "idl"
                  : "—"
            }
          />
          <Fact label="auth" value={authorityLabel(program.authorityClass)} />
          <Fact
            label="funded by"
            value={
              program.deployerFundingSource ??
              (program.funderAddress
                ? truncateAddress(program.funderAddress)
                : "untraced")
            }
          />
          <Fact
            label="signers"
            value={
              program.earlySigners != null ? String(program.earlySigners) : "—"
            }
          />
        </div>
      </div>

      <div className="radar-gauge" title={`novelty ${program.noveltyScore.toFixed(2)}`}>
        <span className="gauge-num">{gauge}</span>
        <span className="gauge-label">novelty</span>
      </div>
    </article>
  );
}
