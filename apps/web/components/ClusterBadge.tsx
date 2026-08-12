import type { ApiProgram } from "@/lib/api";

// ---------------------------------------------------------------------------
// The cluster badge.
//
// It used to read `DEVNET`, titled "Deployed on devnet, not mainnet" — which
// was not what the data said. subjects.id is the program address alone, so a
// program deployed to both clusters is ONE row and `network` was whichever
// cluster's loader event we saw last.
//
// Mainnet takes precedence: a program live on mainnet is a mainnet program and
// carries no devnet badge, whatever we polled most recently. Its devnet life
// shows up as history in the lineage panel, not as a label on its identity.
// Promotion (counterpart.ts) is what makes `program.network` deserve that
// trust — a devnet row found live on mainnet is re-ingested from mainnet.
//
// So this component only ever speaks for devnet rows, and its whole job is
// distinguishing the two devnet answers the record can give: probed and
// genuinely devnet-only, or never probed and therefore unknown.
// ---------------------------------------------------------------------------

const dayOf = (iso: string): string => iso.slice(0, 10);

export function ClusterBadge({ program }: { program: ApiProgram }) {
  if (program.network !== "devnet") return null;
  const cp = program.counterpart;

  // Probed and live on mainnet, yet still labelled devnet: promotion has not
  // run (or could not). Say the truer thing rather than the stored one.
  if (cp?.present && cp.alive !== false) {
    return (
      <span
        className="net-badge net-badge-both"
        title={`This program id is live on mainnet (probed ${dayOf(cp.checkedAt)}${cp.deployedAt ? `, last deployed there ${dayOf(cp.deployedAt)}` : ""}). The figures on this page were read from devnet.`}
      >
        on mainnet too
      </span>
    );
  }

  return (
    <span
      className="net-badge"
      title={
        cp
          ? `Devnet only. Probed mainnet at this address ${dayOf(cp.checkedAt)}${cp.present ? " — the mainnet deployment is closed" : " — nothing there"}.`
          : "The last loader event we saw for this address was on devnet. Mainnet has not been probed, so whether it also runs there is unknown — not no."
      }
    >
      {cp ? "devnet only" : "devnet"}
    </span>
  );
}
