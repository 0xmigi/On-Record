import Link from "next/link";
import { Sparkline } from "@/components/Sparkline";
import { truncateAddress } from "@/lib/format";
import type { ApiEdgeNode, ApiProgramDetail } from "@/lib/api";

// ---------------------------------------------------------------------------
// Map — the reference graph: what reaches for this program, and what it reaches
// for.
//
// Drawn in DOM, not SVG, after two failed attempts taught the reason. SVG text
// scales with the drawing, so a diagram authored at 380 and displayed at 520
// renders every label 37% larger than the dossier around it — which is why the
// first two versions read as clunky next to the rest of the page no matter how
// the boxes were arranged. DOM keeps the type on the site's own scale at every
// width, and reflows: one column on a phone, two or three as the space appears,
// instead of one endless ladder.
//
// The shape is three tiers, top to bottom — callers, this program, callees —
// with the program as a solid bar between them. Reading down the page IS the
// direction of reference, so the arrows are markers on that flow rather than
// the thing carrying it.
//
// Every edge is a 32-byte program id compiled into the image. That proves the
// code NAMES another program, not that it calls it — a callee handed in as a
// runtime account leaves no constant behind — so this under-reports rather than
// invents, and nothing here is labelled "calls".
// ---------------------------------------------------------------------------

type Edge = ApiEdgeNode;

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

const PER_TIER = 12;

/** 7,783 → "7.8k". A chip has room for a magnitude, not a census, and the exact
 *  figure is one click away on the neighbour's own dossier. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function Chip({ e, sub, scale }: { e: Edge; sub: string; scale: number }) {
  // Deliberately the neighbour's OWN volume, and captioned that way on hover.
  // The number sits beside an arrow, and a number beside an arrow reads as flow
  // along it — which this is not, and cannot be until inner instructions are
  // parsed. The one thing that must never happen here is a reader concluding
  // "7.8k transactions go from kvault into klend" from a figure that means
  // "kvault does 7.8k transactions of its own".
  const traffic =
    e.txns24h != null && e.txns24h > 0
      ? `${compact(e.txns24h)}${e.txnsTruncated ? "+" : ""}`
      : null;
  return (
    <Link
      href={`/p/${e.id}`}
      className="map-chip"
      title={
        traffic
          ? `${e.name ?? e.id} — ${e.txns24h!.toLocaleString("en-US")}${e.txnsTruncated ? "+" : ""} of its own transactions in 24h (not traffic over this link)`
          : (e.name ?? e.id)
      }
    >
      <span className="map-chip-text">
        <span className="map-chip-name">{e.name ?? truncateAddress(e.id)}</span>
        <span className="map-chip-sub">{sub}</span>
      </span>
      {/* The slot is always rendered, even with nothing in it. Omitting it for
          unsampled programs left every card a different shape and the column
          ragged — and a missing chart reads as "no traffic" when it means "not
          sampled". A dash says the second thing. */}
      <span className={`map-chip-act${traffic ? "" : " map-chip-act-none"}`}>
        {traffic ? (
          <>
            {/* Two windows sit side by side here and they are NOT the same
                window: the chart is 7 days, the number is the last 24h. Left
                unlabelled they read as one measurement, and a reader would take
                the number as the chart's total. Both get a caption. */}
            <span className="map-chip-win">7d</span>
            {e.activity && e.activity.length > 1 ? (
              <Sparkline points={e.activity} width={104} height={30} max={scale} baseline title="" />
            ) : (
              <span className="map-chip-nospark" />
            )}
            <span className="map-chip-txns">
              {traffic}
              <span className="map-chip-win">/24h</span>
            </span>
          </>
        ) : (
          <span className="map-chip-txns" title="not sampled — the momentum sampler hasn't reached this program">
            —
          </span>
        )}
      </span>
    </Link>
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

  const inbound = allIn.slice(0, PER_TIER);
  const outbound = allOut.slice(0, PER_TIER);

  if (!inbound.length && !outbound.length) {
    return (
      <p className="map-empty">
        No program on record embeds this program&apos;s id, and its own binary
        embeds none. Either it sits at the edge of the graph, or its
        neighbourhood hasn&apos;t been scanned yet.
      </p>
    );
  }

  // A crate under a program name is useful right up until two chips carry the
  // same one — Kamino ships metavault twice, and two identical chips read as a
  // rendering bug. Where a name repeats, the address disambiguates instead.
  const nameCount = new Map<string, number>();
  for (const e of [...inbound, ...outbound, self]) {
    const n = e.name ?? e.id;
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const subFor = (e: Edge) =>
    (nameCount.get(e.name ?? e.id) ?? 0) > 1 || !e.crate ? truncateAddress(e.id) : e.crate;

  // ONE scale for every spark on the panel, including the program's own.
  //
  // Sparklines normalised individually are the same picture repeated: each one
  // fills its box, so Kamino Meta Vault at 6 transactions a day drew exactly as
  // tall as Kamino Lending Vault at 7,783. That is not a small cosmetic problem
  // — it deletes the only thing a row of charts is for. Reading across programs
  // is the entire reason these are here rather than on each program's own page,
  // where the Traction chart already shows the same series better.
  //
  // Scaled to the busiest neighbour, the panel finally says something at a
  // glance: who is big, who is idle, and whether this program sits among giants
  // or among dust.
  const peak = Math.max(
    1,
    ...[...inbound, ...outbound, self].flatMap((e) => (e.activity ?? []).map((p) => p.c)),
  );
  const busiest = [...inbound, ...outbound, self]
    .filter((e) => e.txns24h)
    .sort((a, b) => (b.txns24h ?? 0) - (a.txns24h ?? 0))[0];

  return (
    <div className="map">
      {inbound.length ? (
        <section className="map-tier">
          <h4 className="map-tier-head">
            <span className="map-tier-n">{allIn.length}</span>
            program{allIn.length === 1 ? "" : "s"} reach for this
            {allIn.length > inbound.length ? (
              <span className="map-tier-cap"> · {inbound.length} shown</span>
            ) : null}
          </h4>
          <div className="map-grid">
            {inbound.map((e) => (
              <Chip key={`i${e.id}`} e={e} sub={subFor(e)} scale={peak} />
            ))}
          </div>
          <div className="map-flow" aria-hidden="true" />
        </section>
      ) : null}

      <div className="map-self">
        <span className="map-self-name">{self.name ?? truncateAddress(self.id)}</span>
        <span className="map-self-sub">{self.crate ?? truncateAddress(self.id)}</span>
        {/* the centre carries its own number too — without it the neighbours'
            volumes have nothing to be large or small against, and "is this
            program the big one here or the small one" is most of the question */}
        {self.txns24h != null && self.txns24h > 0 ? (
          <span className="map-chip-act map-self-act">
            <span className="map-chip-win">7d</span>
            {/* Taller than the neighbours', on the same scale. This is the
                program the reader came for, and it is the one whose shape —
                the spikes, the flat stretches, the day it stopped — is worth
                actually resolving rather than merely comparing. */}
            {self.activity && self.activity.length > 1 ? (
              <Sparkline points={self.activity} width={168} height={48} max={peak} baseline title="" />
            ) : null}
            <span className="map-chip-txns">
              {compact(self.txns24h)}
              {self.txnsTruncated ? "+" : ""}
              <span className="map-chip-win">/24h</span>
            </span>
          </span>
        ) : null}
      </div>

      {outbound.length ? (
        <section className="map-tier">
          <div className="map-flow" aria-hidden="true" />
          <h4 className="map-tier-head">
            this reaches for
            <span className="map-tier-n map-tier-n-after">{allOut.length}</span>
            {allOut.length > outbound.length ? (
              <span className="map-tier-cap"> · {outbound.length} shown</span>
            ) : null}
          </h4>
          <div className="map-grid">
            {outbound.map((e) => (
              <Chip key={`o${e.id}`} e={e} sub={subFor(e)} scale={peak} />
            ))}
          </div>
        </section>
      ) : null}

      <p className="map-note">
        <strong>Every chart shares one scale</strong>
        {busiest?.txns24h
          ? `, set by ${busiest.name ?? truncateAddress(busiest.id)} at ${busiest.txns24h.toLocaleString("en-US")} transactions in 24h`
          : ""}
        , so heights are comparable across the panel — a flat line is a quiet
        program, not a small chart. Each is that program&apos;s <strong>own</strong>{" "}
        7-day traffic, not traffic across the link it sits next to; flow along an
        edge needs the inner instructions of parsed transactions, which On Record
        doesn&apos;t read yet. A <code>+</code> means the sampler hit its page cap
        and the real figure is higher.
      </p>

      <p className="map-note">
        Each link is a 32-byte program id compiled into the binary above it. That
        proves the code <strong>names</strong> the program it points to — an
        integration, a dependency, a whitelisted market — not that it called it in
        any particular transaction. A callee passed in as a runtime account leaves
        no constant behind, so this map misses links rather than inventing them.
        {hidden > 0 ? (
          <> {hidden} link{hidden === 1 ? "" : "s"} to chain infrastructure (SPL Token, Squads and the like) sit under Composition → Embedded instead.</>
        ) : null}
      </p>
    </div>
  );
}
