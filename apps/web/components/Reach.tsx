import Link from "next/link";
import { truncateAddress } from "@/lib/format";
import type { ApiProgramDetail } from "@/lib/api";

// ---------------------------------------------------------------------------
// Map — the reference graph drawn as a flow, not listed as a table.
//
// The first version of this panel was two columns of program names, which is
// the raw query result wearing a coat: it told you WHICH programs touch this
// one and nothing about how they sit together. The question the panel exists to
// answer is positional — where does this program sit in the stack — and that is
// a shape, so it gets drawn as one.
//
// Left to right is direction of reference: things that reach for this program,
// the program, the things it reaches for. Read as one line, klend goes from
// "Lulo and divvy-house depend on me" to "I depend on kvault and Meteora",
// which is the sentence the two lists never managed to say.
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
const W = 760;
const COL = 208; // node box width
const NODE_H = 34;
const GAP = 10;
const MID_X = (W - COL) / 2;
const RIGHT_X = W - COL;
const PER_SIDE = 7; // beyond this the drawing stops being readable

function label(e: Edge): string {
  const n = e.name ?? truncateAddress(e.id);
  return n.length > 26 ? `${n.slice(0, 25)}…` : n;
}

function Node({
  e,
  x,
  y,
  variant,
  sub,
}: {
  e: Edge;
  x: number;
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
        x={x}
        y={y}
        width={COL}
        height={NODE_H}
        rx={7}
        className={`map-box map-box-${variant}`}
      />
      <text x={x + 11} y={y + 15} className="map-label">
        {label(e)}
      </text>
      <text x={x + 11} y={y + 27} className="map-sub">
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

/** A left-to-right connector with a little S-curve, so parallel edges stay
 *  distinguishable instead of collapsing into one straight bar. */
function Edge2({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const dx = Math.max(24, (x2 - x1) / 2);
  return (
    <path
      d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
      className="map-edge"
      markerEnd="url(#map-arrow)"
    />
  );
}

function column(edges: Edge[], centreY: number): { e: Edge; y: number }[] {
  const total = edges.length * NODE_H + (edges.length - 1) * GAP;
  const top = centreY - total / 2;
  return edges.map((e, i) => ({ e, y: top + i * (NODE_H + GAP) }));
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

  // A crate name under a program name is useful right up until two nodes carry
  // the same one — Kamino ships metavault twice, and two identical boxes look
  // like a bug. Where a name repeats, the address disambiguates instead.
  const nameCount = new Map<string, number>();
  for (const e of [...inbound, ...outbound, self]) {
    const n = e.name ?? e.id;
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const subFor = (e: Edge) =>
    (nameCount.get(e.name ?? e.id) ?? 0) > 1 || !e.crate ? truncateAddress(e.id) : e.crate;

  const rows = Math.max(inbound.length, outbound.length, 1);
  const H = Math.max(rows * (NODE_H + GAP) + 40, 140);
  const centreY = H / 2 - NODE_H / 2;
  const left = column(inbound, centreY + NODE_H / 2);
  const right = column(outbound, centreY + NODE_H / 2);

  return (
    <div className="map">
      <div className="map-legend">
        <span className="map-legend-in">reaches for this</span>
        <span className="map-legend-arrow">→</span>
        <span className="map-legend-self">{self.name ?? truncateAddress(self.id)}</span>
        <span className="map-legend-arrow">→</span>
        <span className="map-legend-out">this reaches for</span>
      </div>

      <div className="map-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} className="map-svg" role="img"
          aria-label={`Reference map: ${inbound.length} programs name this one, it names ${outbound.length}`}>
          <defs>
            <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7"
              markerHeight="7" orient="auto">
              <path d="M 0 1 L 7 4 L 0 7 z" className="map-arrowhead" />
            </marker>
          </defs>

          {left.map(({ y }, i) => (
            <Edge2 key={`ei${i}`} x1={COL} y1={y + NODE_H / 2} x2={MID_X - 4} y2={centreY + NODE_H / 2} />
          ))}
          {right.map(({ y }, i) => (
            <Edge2 key={`eo${i}`} x1={MID_X + COL} y1={centreY + NODE_H / 2} x2={RIGHT_X - 4} y2={y + NODE_H / 2} />
          ))}

          {left.map(({ e, y }) => (
            <Node key={`i${e.id}`} e={e} x={0} y={y} variant="in" sub={subFor(e)} />
          ))}
          <Node e={self} x={MID_X} y={centreY} variant="self" sub={subFor(self)} />
          {right.map(({ e, y }) => (
            <Node key={`o${e.id}`} e={e} x={RIGHT_X} y={y} variant="out" sub={subFor(e)} />
          ))}
        </svg>
      </div>

      {moreIn > 0 || moreOut > 0 ? (
        <p className="map-more">
          {moreIn > 0 ? `${moreIn} more program${moreIn === 1 ? "" : "s"} name this one. ` : ""}
          {moreOut > 0 ? `${moreOut} more named by this one. ` : ""}
          Drawn to {PER_SIDE} a side.
        </p>
      ) : null}

      <p className="map-note">
        Each arrow is a 32-byte program id compiled into the binary at its tail.
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
