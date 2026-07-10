import Link from "next/link";
import { ProgramRow } from "@/components/ProgramRow";
import type { ApiProgram } from "@/lib/api";
import { relativeTime, truncateAddress } from "@/lib/format";

// A bot cluster on the feed: the most recent redeploy shown as a normal row,
// the rest of that byte-identical cluster stacked underneath, collapsed. Turns
// "one bot × N disposable ids" from N rows of noise into one explorable entry.

function txns(p: ApiProgram): string | null {
  const n = p.momentum?.txns24h ?? p.earlySigners ?? null;
  if (!n) return null;
  return `${n.toLocaleString("en-US")}${n % 1000 === 0 ? "+" : ""} txns`;
}

export function ClusterGroup({
  rep,
  members,
}: {
  rep: ApiProgram;
  members: ApiProgram[];
}) {
  if (!members.length) return <ProgramRow program={rep} />;

  const closed = members.filter((m) => m.closed).length;

  return (
    <div className="cluster-group">
      <ProgramRow program={rep} />
      <details className="cluster-stack">
        <summary className="cluster-stack-summary">
          <span className="cluster-stack-chev" aria-hidden="true">
            ⌄
          </span>
          <span>
            + {members.length} more identical redeploy
            {members.length > 1 ? "s" : ""} today
            {closed ? ` · ${closed} already closed` : ""}
          </span>
        </summary>
        <ul className="cluster-stack-list">
          {members.map((m) => (
            <li key={m.id} className="cluster-stack-item">
              <Link href={`/p/${m.id}`} className="cluster-stack-addr">
                {truncateAddress(m.id)}
              </Link>
              <span className="cluster-stack-meta">
                {relativeTime(m.deployedAt)}
                {txns(m) ? ` · ${txns(m)}` : ""}
                {m.closed ? " · closed" : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
