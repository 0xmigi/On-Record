import Link from "next/link";
import { truncateAddress } from "@/lib/format";
import type { ApiProgramDetail } from "@/lib/api";

// ---------------------------------------------------------------------------
// Map — the reference graph drawn as a flow.
//
// The first version was two columns of program names, which is the query result
// wearing a coat: it said WHICH programs touch this one and nothing about how
// they sit together. The question a reader brings is positional — where does
// this sit in the stack — and position is a shape, so it gets drawn as one.
//
// It flows DOWN a spine rather than left-to-right. Sideways looked better on a
// desktop screenshot and was the wrong choice: a horizontal graph is bounded by
// the width it will never get on a phone, so it has to either shrink its labels
// or scroll in a box, and a graph you scroll sideways is a graph you can't read
// as one thing. Vertical has the axis that's free — the page already scrolls
// that way — so the drawing can grow to whatever the neighbourhood needs.
//
// Everything above the program reaches for it; everything below, it reaches for.
//
// Every edge is a 32-byte program id compiled into the image. That proves the
// code NAMES another program, not that it calls it — a callee handed in as a
// runtime account leaves no constant behind — so this under-reports rather than
// invents, and nothing here is labelled "calls".
// ---------------------------------------------------------------------------

type Edge = { id: string; name: string | null; crate: string | null };

/** Programs so widely embedded that naming them says nothing about position.
 *  The chain's standard library: 17 of the first 21 programs scanned named SPL
 *  Token. They stay on the Composition tab under "Embedded", where the question
 *  is "does this handle tokens" — here they would bury every real edge. */
const INFRASTRUCTURE = new Set([
  "SPL Token",
  "Token-2022",
  "Associated Token Account",
  "Compute Budget",
  "Metaplex",
  "Metaplex Metadata",
  "Realms Governance",
  "Squads",
  "Squads MPL",
  "Squads v4",
]);

// --- geometry ---------------------------------------------------------------
// One column, scaled to the container. 380 is a phone's usable width, so the
// drawing is authored at the size where it's tightest and scales UP from there
// — the reverse of authoring wide and hoping it survives the squeeze.
const W = 380;
const RAIL = 18; // x of the vertical spine
const NODE_X = 44;
const NODE_W = W - NODE_X - 6;
const NODE_H = 40;
const GAP = 11;
const LABEL_H = 22;
const PER_SIDE = 8;

function label(e: Edge): string {
  const n = e.name ?? truncateAddress(e.id);
  return n.length > 30 ? `${n.slice(0, 29)}…` : n;
}

function Node({
  e,
  y,
  variant,
  sub,
}: {
  e: Edge;
  y: number;
  variant: "self" | "in" | "out";
  /** normally the crate — but the address when two nodes share a name, since
   *  "Kamino Meta Vault / metavault" twice reads as a rendering bug rather than
   *  as the two separate deploys it actually is */
  sub: string;
}) {
  const body = (
    <>
      <rect
        x={NODE_X}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={7}
        className={`map-box map-box-${variant}`}
      />
      <text x={NODE_X + 12} y={y + 17} className="map-label">
        {label(e)}
      </text>
      <text x={NODE_X + 12} y={y + 30} className="map-sub">
        {sub}
      </text>
    </>
  );
  if (variant === "self") return body;
  return (
    <Link href={`/p/${e.id}`}>
      <title>{e.name ?? e.id}</title>
      {body}
    </Link>
  );
}

/** Elbow from the spine to a node (or back), drawn as a quarter-round rather
 *  than a diagonal so the spine reads as one continuous line. */
function Elbow({ y, dir }: { y: number; dir: "in" | "out" }) {
  const midY = y + NODE_H / 2;
  const r = 9;
  if (dir === "in") {
    // node → spine: leaves the node's left edge, turns down onto the rail
    return (
      <path
        d={`M ${NODE_X - 4} ${midY} H ${RAIL + r} Q ${RAIL} ${midY} ${RAIL} ${midY + r}`}
        className="map-edge"
      />
    );
  }
  // spine → node: leaves the rail, turns right into the node's left edge
  return (
    <path
      d={`M ${RAIL} ${midY - r} Q ${RAIL} ${midY} ${RAIL + r} ${midY} H ${NODE_X - 5}`}
      className="map-edge"
      markerEnd="url(#map-arrow)"
    />
  );
}

export function ReachMap({
  self,
  references,
}: {
  self: Edge;
  references: ApiProgramDetail["references"];
}) {
  const strip = (edges: Edge[]) => {
    const seen = new Set<string>();
    return edges.filter((e) => {
      if (e.name && INFRASTRUCTURE.has(e.name)) return false;
      if (seen.has(e.id)) return false; // the same edge can be read twice
      seen.add(e.id);
      return true;
    });
  };
  const allIn = strip(references?.namedBy ?? []);
  const allOut = strip(references?.names ?? []);
  const hidden =
    (references?.namedBy.length ?? 0) - allIn.length + ((references?.names.length ?? 0) - allOut.length);

  const inbound = allIn.slice(0, PER_SIDE);
  const outbound = allOut.slice(0, PER_SIDE);
  const moreIn = allIn.length - inbound.length;
  const moreOut = allOut.length - outbound.length;

  if (!inbound.length && !outbound.length) {
    return (
      <p className="map-empty">
        No program on record embeds this program&apos;s id, and its own binary
        embeds none. Either it sits at the edge of the graph, or its
        neighbourhood hasn&apos;t been scanned yet.
      </p>
    );
  }

  // A crate under a program name is useful right up until two nodes carry the
  // same one — Kamino ships metavault twice, and two identical boxes read as a
  // rendering bug. Where a name repeats, the address disambiguates instead.
  const nameCount = new Map<string, number>();
  for (const e of [...inbound, ...outbound, self]) {
    const n = e.name ?? e.id;
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const subFor = (e: Edge) =>
    (nameCount.get(e.name ?? e.id) ?? 0) > 1 || !e.crate ? truncateAddress(e.id) : e.crate;

  // --- vertical layout: label, inbound stack, self, label, outbound stack ---
  let y = 0;
  const inLabelY = inbound.length ? (y += LABEL_H) : 0;
  const inNodes = inbound.map((e) => {
    const at = y;
    y += NODE_H + GAP;
    return { e, y: at };
  });
  if (inbound.length) y += 6;
  const selfY = y;
  y += NODE_H;
  const outLabelY = outbound.length ? (y += LABEL_H + 6) : 0;
  const outNodes = outbound.map((e) => {
    const at = y;
    y += NODE_H + GAP;
    return { e, y: at };
  });
  const H = y + 4;

  const firstIn = inNodes[0];
  const lastOut = outNodes[outNodes.length - 1];

  return (
    <div className="map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="map-svg"
        role="img"
        aria-label={`Reference map: ${allIn.length} programs name ${self.name ?? "this program"}, it names ${allOut.length}`}
      >
        <defs>
          <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7"
            markerHeight="7" orient="auto">
            <path d="M 0 1 L 7 4 L 0 7 z" className="map-arrowhead" />
          </marker>
        </defs>

        {/* the spine: down from the first inbound node into the program… */}
        {firstIn ? (
          <path
            d={`M ${RAIL} ${firstIn.y + NODE_H / 2} V ${selfY + NODE_H / 2}`}
            className="map-edge"
            markerEnd="url(#map-arrow)"
          />
        ) : null}
        {/* …then on down to the last thing it reaches for */}
        {lastOut ? (
          <path
            d={`M ${RAIL} ${selfY + NODE_H / 2} V ${lastOut.y + NODE_H / 2}`}
            className="map-edge"
          />
        ) : null}

        {inbound.length ? (
          <text x={0} y={inLabelY - 8} className="map-group">
            {allIn.length} program{allIn.length === 1 ? "" : "s"} reach for this
          </text>
        ) : null}
        {inNodes.map(({ e, y: ny }) => (
          <g key={`i${e.id}`}>
            <Elbow y={ny} dir="in" />
            <Node e={e} y={ny} variant="in" sub={subFor(e)} />
          </g>
        ))}

        <Node e={self} y={selfY} variant="self" sub={subFor(self)} />

        {outbound.length ? (
          <text x={0} y={outLabelY - 8} className="map-group">
            this reaches for {allOut.length}
          </text>
        ) : null}
        {outNodes.map(({ e, y: ny }) => (
          <g key={`o${e.id}`}>
            <Elbow y={ny} dir="out" />
            <Node e={e} y={ny} variant="out" sub={subFor(e)} />
          </g>
        ))}
      </svg>

      {moreIn > 0 || moreOut > 0 ? (
        <p className="map-more">
          {moreIn > 0 ? `${moreIn} more above not drawn. ` : ""}
          {moreOut > 0 ? `${moreOut} more below not drawn. ` : ""}
          Capped at {PER_SIDE} each way.
        </p>
      ) : null}

      <p className="map-note">
        Each arrow is a 32-byte program id compiled into the binary it leaves.
        That proves the code <strong>names</strong> the program it points to — an
        integration, a dependency, a whitelisted market — not that it called it
        in any particular transaction. A callee passed in as a runtime account
        leaves no constant behind, so this map misses edges rather than inventing
        them.
        {hidden > 0 ? (
          <> {hidden} link{hidden === 1 ? "" : "s"} to chain infrastructure (SPL Token, Squads and the like) sit under Composition → Embedded instead.</>
        ) : null}
      </p>
    </div>
  );
}
