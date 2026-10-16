import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchProgram, fetchVerification } from "@/lib/api";
import { machineLabel, rebuildRecord, type Attempt, type Rebuild } from "@/lib/rebuilds";

/**
 * A verification run, as a report: the result, the two fingerprints lined up
 * (the deployed one read from chain by the API, the rebuilt one from the
 * build), every attempt it took, and why that machine. sha256 over the ELF
 * with trailing zero padding stripped on both sides, so one changed byte
 * anywhere breaks every column.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: "Verification run",
    alternates: { canonical: `/p/${id}/rebuild` },
    robots: { index: false },
  };
}

/** 64 hex chars → 8 groups of 8, so the two fingerprints line up column by column */
function groups(hash: string): string[] {
  return hash.match(/.{1,8}/g) ?? [];
}

const RESULT: Record<Attempt["result"], string> = {
  match: "✓ match",
  differs: "✗ different bytes",
  build: "✗ didn't compile",
  fetch: "✗ source unavailable",
  skip: "✗ no version clue",
};

function machineNote(r: Rebuild): string {
  const used = machineLabel(r.machine);
  if (r.clue === "mac") return `The deployed file carries paths from the Mac compiler download, so it was rebuilt on a Mac. ${used} matched.`;
  if (r.clue === "linux") return `The deployed file carries paths from the Linux compiler download, so it was rebuilt on Linux.`;
  return `The deployed file doesn't say which machine built it. ${used} was tried first and matched.`;
}

export default async function RebuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rebuild = rebuildRecord(id);
  if (!rebuild) notFound();
  const [program, verification] = await Promise.all([fetchProgram(id), fetchVerification(id)]);
  if (!program) notFound();

  const deployed = verification?.current?.hash ?? null;
  const built = groups(rebuild.hash);
  const onChain = deployed ? groups(deployed) : [];
  const identical = deployed === rebuild.hash;
  const repo = rebuild.repo.replace("https://github.com/", "");

  return (
    <div className="run-page">
      <Link href={`/p/${id}`} className="run-back">
        ← {program.name ?? id}
      </Link>

      <p className="run-eyebrow">Verification run · On Record</p>
      <div className={identical ? "run-result ok" : "run-result no"}>
        <span className="run-result-mark">{identical ? "✓ Match" : "✗ No longer matches"}</span>
        <span className="run-result-what">
          <a href={`${rebuild.repo}/tree/${rebuild.commit}`} target="_blank" rel="noopener noreferrer">
            {repo} @ {rebuild.commit.slice(0, 7)}
          </a>{" "}
          rebuilt and compared with the deployed program · {rebuild.at}
        </span>
      </div>

      <section className="run-section">
        <h2 className="run-h">Fingerprints</h2>
        <div className="run-box">
          <div className="run-fp">
            <span className="run-label">Deployed on mainnet</span>
            <span className="run-hash">
              {deployed
                ? onChain.map((g, i) => (
                    <span key={i} className={g === built[i] ? "run-g same" : "run-g diff"}>
                      {g}
                    </span>
                  ))
                : "unavailable"}
            </span>
          </div>
          <div className="run-fp">
            <span className="run-label">Rebuilt from source</span>
            <span className="run-hash">
              {built.map((g, i) => (
                <span key={i} className={g === onChain[i] ? "run-g same" : "run-g diff"}>
                  {g}
                </span>
              ))}
            </span>
          </div>
          <p className={identical ? "run-verdict ok" : "run-verdict no"}>
            {identical
              ? `Identical${rebuild.size ? `: all ${rebuild.size.toLocaleString("en-US")} bytes` : ""}`
              : "The program was upgraded after this rebuild"}
          </p>
        </div>
      </section>

      <section className="run-section">
        <h2 className="run-h">Attempts · {rebuild.attempts.length}</h2>
        <table className="run-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Machine</th>
              <th>Solana</th>
              <th>Commit</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rebuild.attempts.map((a, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{machineLabel(a.machine)}</td>
                <td>{a.solana || "—"}</td>
                <td>{a.commit}</td>
                <td className={a.result === "match" ? "run-ok" : "run-no"}>{RESULT[a.result]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="run-note">{machineNote(rebuild)}</p>
      </section>

      <p className="run-foot">
        {rebuild.source === "security.txt"
          ? "Repo and commit from the program's security.txt · no verification recipe on chain"
          : "Repo and commit from the program's on-chain verification recipe"}
        {" · "}
        <a href={rebuild.run} target="_blank" rel="noopener noreferrer">
          build log ↗
        </a>
      </p>
    </div>
  );
}
