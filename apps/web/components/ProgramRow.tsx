import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { SignalHex } from "@/components/SignalHex";
import { Sparkline } from "@/components/Sparkline";
import type { ApiProgram } from "@/lib/api";
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

/* link icons (bottom of card): globe / X / GitHub, muted until hover */
function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.8 2.6 4.2 5.6 4.2 9S14.8 18.4 12 21c-2.8-2.6-4.2-5.6-4.2-9S9.2 5.6 12 3z" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
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
/** `showNetwork` tags devnet rows. Opt-in, because the radar already scopes to
 *  one cluster at a time — only mixed lists (search) need to say which.
 *  `leadWith` picks which date opens the history line: every list leads with the
 *  date it is sorted by, so the upgrades stream leads with the code change and
 *  keeps the original deploy as trailing context. */
export function ProgramRow({
  program,
  showNetwork = false,
  leadWith = "deploy",
}: {
  program: ApiProgram;
  showNetwork?: boolean;
  leadWith?: "deploy" | "upgrade";
}) {
  const inCluster = (program.clusterSize ?? 0) > 1;
  const kind = botKind(program); // 'sniper' | 'throwaway' | 'duplicate' | null
  const signals = deriveSignals(program);
  const notableIntegrations = program.integrations.filter(
    (i) => !UBIQUITOUS_INTEGRATIONS.has(i),
  );
  const txns24h = program.momentum?.txns24h ?? null;
  const isFork =
    program.band === "variant" &&
    Boolean(program.nearest?.isReference) &&
    (program.nearest?.similarity ?? 0) >= 0.6;
  const resembles =
    Boolean(program.nearest?.isReference) && (program.nearest?.similarity ?? 0) >= 0.4;
  // lastEventAt is the program's most recent loader event — for an upgraded
  // program that IS the code change. Falls back to leading with the deploy date
  // if the row has never carried one.
  const leadsWithUpgrade = leadWith === "upgrade" && Boolean(program.lastEventAt);
  const upgradeTimes =
    program.upgradeCount > 0
      ? `×${program.upgradeCount}${program.upgradeCountTruncated ? "+" : ""}`
      : null;

  return (
    <article className="radar-row">
      <Link
        className="radar-row-link"
        href={`/p/${program.id}`}
        aria-label={`Open ${program.name ?? truncateAddress(program.id)}`}
      />
      <div className="radar-main">
        {/* title: avatar + name + id + copy on ONE line, id muted next to
            the bold name (original layout — founder decision, keep it) */}
        <div className={`radar-id-line${program.name ? " has-name" : ""}`}>
          <ProgramAvatar program={program} />
          {program.name ? (
            <span className="radar-name">{program.name}</span>
          ) : null}
          {showNetwork && program.network === "devnet" ? (
            <span className="net-badge" title="Deployed on devnet, not mainnet">
              devnet
            </span>
          ) : null}
          <CopyAddress
            value={program.id}
            display={truncateAddress(program.id)}
            href={`/p/${program.id}`}
            className="radar-addr"
          />
          {program.website || program.social || program.repoUrl ? (
            <span className="radar-links">
              {program.website ? (
                <a href={program.website} target="_blank" rel="noopener noreferrer" title={program.website} aria-label="Website">
                  <GlobeIcon />
                </a>
              ) : null}
              {program.social ? (
                <a href={program.social} target="_blank" rel="noopener noreferrer" title={program.social} aria-label="X profile">
                  <XIcon />
                </a>
              ) : null}
              {program.repoUrl ? (
                <a href={program.repoUrl} target="_blank" rel="noopener noreferrer" title={program.repoUrl} aria-label="GitHub repo">
                  <GitHubIcon />
                </a>
              ) : null}
            </span>
          ) : null}
        </div>

        {/* history row: when it arrived, then what's happened since —
            "deployed" leads so every card's second line starts the same way.
            On the upgrades stream the code change leads instead (that's what
            the list is sorted by) and the deploy date trails it. */}
        <div className="radar-ident radar-indent">
          <span className="radar-when">
            {leadsWithUpgrade
              ? `upgraded ${relativeTime(program.lastEventAt)}`
              : `deployed ${relativeTime(program.deployedAt)}`}
          </span>
          {upgradeTimes ? (
            <span className="cluster-note" title="Times this program has been re-deployed">
              {leadsWithUpgrade ? upgradeTimes : `upgraded ${upgradeTimes}`}
            </span>
          ) : null}
          {leadsWithUpgrade ? (
            <span className="cluster-note" title="When this program first went on record">
              deployed {relativeTime(program.deployedAt)}
            </span>
          ) : null}
          {program.hasSecurityTxt ? (
            <span className="sec-badge" title="Embeds a security.txt in its binary">
              security.txt
            </span>
          ) : null}
          {program.verified ? (
            <span className="verified-check" title="Verified build — reproduces from public source; the dossier links the repo">
              ✓ verified
            </span>
          ) : null}
          {isFork && program.nearest?.name ? (
            <span className="fork-chip" title={`${Math.round(program.nearest.similarity * 100)}% code match to ${program.nearest.name}`}>
              fork of {program.nearest.name}
            </span>
          ) : null}
          {kind === "recycled" ? (
            <span className="dup-chip" title="Byte-identical bytecode to other deploys on record — same code, fresh id">
              recycled
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
            <span className="cluster-note" title="Byte/structurally similar programs on record — its copy-paste cluster (all-time, not today)">
              ×{program.clusterSize} in cluster
            </span>
          ) : null}
          {program.closed ? (
            <span className="closed-chip" title="Program closed — ProgramData deallocated, rent reclaimed">
              closed
            </span>
          ) : null}
          {program.incubation ? (
            <span
              className="radar-devnet"
              title={`Seen on devnet ${program.incubation.incubationDays >= 1 ? `${program.incubation.incubationDays} days` : "under a day"} before this mainnet deploy — less likely a throwaway`}
            >
              · seen on devnet
            </span>
          ) : null}
        </div>

        {/* specs row, most-common first: size (always) · cost · built with ·
            talks to · resembles · auth */}
        <div className="radar-facts radar-indent">
          <Fact label="size" value={formatBytes(program.sizeBytes)} />
          {/* devnet rent is faucet SOL — showing a "cost" there would be
              misleading, so the fact is mainnet-only */}
          {program.deployCostSol != null && program.network !== "devnet" ? (
            <Fact label="cost" value={`${program.deployCostSol} SOL`} />
          ) : null}
          {program.framework && program.framework !== "unknown" ? (
            <Fact label="built with" value={program.framework} />
          ) : null}
          {notableIntegrations.length > 0 ? (
            <Fact label="talks to" value={notableIntegrations.slice(0, 2).join(", ")} />
          ) : null}
          {resembles && program.nearest?.name ? (
            <Fact
              label="resembles"
              value={`${program.nearest.name} ${Math.round(program.nearest.similarity * 100)}%`}
            />
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
