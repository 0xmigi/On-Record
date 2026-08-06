import Link from "next/link";
import { truncateAddress } from "@/lib/format";
import type { ApiProgramDetail } from "@/lib/api";

// ---------------------------------------------------------------------------
// Reach — the reference graph, in both directions.
//
// Every edge here is a 32-byte program id found inside the binary. That is a
// claim about what the code NAMES, which is why nothing on this panel says
// "calls": most references are callees, but a program can hold an id it only
// validates against, and a callee handed in as a runtime account leaves no
// constant behind at all. The graph under-reports and never invents.
//
// `namedBy` leads, because it is the direction you cannot get anywhere else.
// A program's own imports are roughly its README; who reached for IT is the
// thing no team publishes about itself — klend naming SPL Token says nothing,
// Lulo and divvy-house naming klend says klend has outside integrators.
// ---------------------------------------------------------------------------

type Edge = { id: string; name: string | null; crate: string | null };

/** Programs so widely embedded that naming them carries no information. These
 *  are the chain's standard library — 17 of the first 21 programs scanned
 *  named SPL Token — so they'd bury every real edge under boilerplate. They
 *  still appear on the dossier as `TALKS TO`, which is where a reader expects
 *  "this handles tokens"; this panel is for relationships, not plumbing. */
const INFRASTRUCTURE = new Set([
  "SPL Token",
  "Token-2022",
  "Associated Token Account",
  "Compute Budget",
  "Metaplex",
  "Metaplex Metadata",
  "Realms Governance",
]);

function EdgeList({ edges, empty }: { edges: Edge[]; empty: string }) {
  if (!edges.length) return <p className="reach-empty">{empty}</p>;
  return (
    <ul className="reach-list">
      {edges.map((e) => (
        <li key={e.id}>
          <Link href={`/p/${e.id}`} className="reach-row">
            <span className="reach-name">{e.name ?? truncateAddress(e.id)}</span>
            {e.crate ? <span className="reach-crate">{e.crate}</span> : null}
            <span className="reach-addr">{truncateAddress(e.id)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Reach({ references }: { references: ApiProgramDetail["references"] }) {
  const strip = (edges: Edge[]) => edges.filter((e) => !e.name || !INFRASTRUCTURE.has(e.name));
  const names = strip(references?.names ?? []);
  const namedBy = strip(references?.namedBy ?? []);
  const hiddenCount =
    (references?.names.length ?? 0) - names.length + ((references?.namedBy.length ?? 0) - namedBy.length);

  return (
    <div className="reach">
      <div className="reach-col">
        <h3 className="reach-head">
          Named by<span className="reach-n">{namedBy.length}</span>
        </h3>
        <p className="reach-sub">Programs whose code embeds this program&apos;s id.</p>
        <EdgeList edges={namedBy} empty="No program on record embeds this id." />
      </div>

      <div className="reach-col">
        <h3 className="reach-head">
          Names<span className="reach-n">{names.length}</span>
        </h3>
        <p className="reach-sub">Program ids embedded in this binary.</p>
        <EdgeList edges={names} empty="Embeds no program id on record." />
      </div>

      <p className="reach-note">
        Read from the bytecode: a 32-byte program id compiled into the image.
        That proves this code <strong>names</strong> another program, not that it
        calls it — a callee passed in as a runtime account leaves no constant
        behind, so this graph misses edges rather than inventing them.
        {hiddenCount > 0 ? (
          <> {hiddenCount} link{hiddenCount === 1 ? "" : "s"} to chain infrastructure (SPL Token and friends) are not listed.</>
        ) : null}
      </p>
    </div>
  );
}
