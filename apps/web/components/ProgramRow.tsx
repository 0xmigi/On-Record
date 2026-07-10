import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { SignalHex } from "@/components/SignalHex";
import { Sparkline } from "@/components/Sparkline";
import { CATEGORY_LABELS, type ApiProgram } from "@/lib/api";
import { deriveSignals } from "@/lib/signals";
import { botKind, BOT_LABEL } from "@/lib/lifecycle";
import { formatBytes, relativeTime, truncateAddress } from "@/lib/format";

// Programs CPI into the token programs almost universally — naming them on
// every card is chrome, not signal. The dossier Composition tab keeps them.
const UBIQUITOUS_INTEGRATIONS = new Set(["SPL Token", "Token-2022", "System", "Associated Token"]);

/** "1,000+" when the count sits exactly on a pagination boundary (the
 *  counter caps at full pages, so a round thousand means "at least"). */
function txnCount(n: number): string {
  return n >= 1000 && n % 1000 === 0 ? `${n.toLocaleString("en-US")}+` : n.toLocaleString("en-US");
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
  const inCluster = (program.clusterSize ?? 0) > 1;
  const kind = botKind(program); // 'sniper' | 'throwaway' | 'duplicate' | null
  const signals = deriveSignals(program);
  const notableIntegrations = program.integrations.filter(
    (i) => !UBIQUITOUS_INTEGRATIONS.has(i),
  );
  const txns24h = program.momentum?.txns24h ?? null;

  return (
    <article className="radar-row">
      <Link
        className="radar-row-link"
        href={`/p/${program.id}`}
        aria-label={`Open ${program.name ?? truncateAddress(program.id)}`}
      />
      <div className="radar-main">
        <div className={`radar-id-line${program.name ? " has-name" : ""}`}>
          <ProgramAvatar program={program} />
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
          {kind === "duplicate" ? (
            <span className="dup-chip" title="Byte-identical bytecode to other deploys on record — same code, fresh id">
              duplicate
            </span>
          ) : kind ? (
            <span
              className="bot-chip"
              title={
                kind === "sniper"
                  ? "Byte-clone wired to Pump.fun — the launch-sniper signature"
                  : "A byte-clone that was closed — deploy, run, close to reclaim rent"
              }
            >
              {BOT_LABEL[kind]}
            </span>
          ) : null}
          {inCluster ? (
            <span className="cluster-note">×{program.clusterSize} today</span>
          ) : null}
          {program.closed ? (
            <span className="closed-chip" title="Program closed — ProgramData deallocated, rent reclaimed">
              closed
            </span>
          ) : null}
        </div>

        <div className="radar-sub">
          <span>deployed {relativeTime(program.deployedAt)}</span>
        </div>

        <div className="radar-facts">
          <span className={`cat-chip cat-${program.category}`}>
            {CATEGORY_LABELS[program.category]}
          </span>
          {program.framework && program.framework !== "unknown" ? (
            <span className="fw-chip">{program.framework}</span>
          ) : null}
          {notableIntegrations.length > 0 ? (
            <Fact label="talks to" value={notableIntegrations.slice(0, 2).join(", ")} />
          ) : null}
          {program.nearest?.isReference && program.nearest.similarity >= 0.4 ? (
            <Fact
              label="resembles"
              value={`${program.nearest.name} ${Math.round(program.nearest.similarity * 100)}%`}
            />
          ) : null}
          <Fact label="size" value={formatBytes(program.sizeBytes)} />
          {program.deployCostSol != null ? (
            <Fact label="cost" value={`${program.deployCostSol} SOL`} />
          ) : null}
          {program.multisig ? (
            <Fact
              label="auth"
              value={
                program.multisig.threshold != null
                  ? `squads ${program.multisig.threshold}/${program.multisig.members}`
                  : "squads multisig"
              }
            />
          ) : program.authorityClass === "none" ? (
            <Fact label="auth" value="immutable" />
          ) : null}
          {program.deployerFundingSource &&
          !["fresh", "unknown"].includes(program.deployerFundingSource) ? (
            <Fact label="funded via" value={program.deployerFundingSource} />
          ) : null}
        </div>
      </div>

      <div className="radar-rail">
        <SignalHex signals={signals} size={56} />
        {txns24h != null && txns24h > 0 ? (
          <span className="radar-rail-txns">{txnCount(txns24h)} txns/24h</span>
        ) : program.earlySigners ? (
          <span className="radar-rail-txns">{txnCount(program.earlySigners)} early txns</span>
        ) : null}
        {program.activity && program.activity.length >= 2 ? (
          <Sparkline points={program.activity} width={110} height={22} title="transactions per hour, last 48h" />
        ) : null}
      </div>
    </article>
  );
}
