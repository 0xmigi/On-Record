import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  buildPubkeyIndex,
  db,
  findReferencedPrograms,
  logger,
  newId,
  schema,
  type Network,
  type PubkeyIndex,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Program references — the edge extraction, wired to the corpus.
//
// The scan itself is in core (references.ts). What lives here is the part that
// needs the database: the index of every program on record, and writing the
// resulting edges.
//
// Cost note, because it drove the design: this runs inside the fingerprint
// stage, where the image is ALREADY in memory. Extracting references for every
// new deploy and upgrade therefore costs zero additional RPC — the expensive
// thing was never the scan, it was fetching bytecode, and that fetch has
// already happened by the time we get here.
// ---------------------------------------------------------------------------

/** The corpus index is ~4.6k ids on mainnet and rebuilding it per event would
 *  be a query per deploy for a set that barely moves. Cached per network with a
 *  short TTL: new programs become referenceable within a few minutes, which is
 *  far tighter than the rate at which anyone deploys something that names them. */
const INDEX_TTL_MS = 5 * 60_000;
const cache = new Map<Network, { index: PubkeyIndex; builtAt: number }>();

export async function corpusIndex(network: Network, force = false): Promise<PubkeyIndex> {
  const hit = cache.get(network);
  if (!force && hit && Date.now() - hit.builtAt < INDEX_TTL_MS) return hit.index;
  const rows = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.network, network), eq(schema.subjects.kind, "program")));
  const index = buildPubkeyIndex(rows.map((r) => r.id));
  cache.set(network, { index, builtAt: Date.now() });
  return index;
}

/** Scan one image and replace this program's edge set.
 *
 *  Replace, not merge: an upgrade can drop a reference, and a graph that only
 *  ever gains edges would keep asserting a call that the current build no
 *  longer makes. The delete is scoped to this program's own rows, so a
 *  concurrent extraction of some other program can't be caught by it. */
export async function extractReferences(
  network: Network,
  programId: string,
  bytecode: Buffer,
  sha256: string | null,
): Promise<string[]> {
  const index = await corpusIndex(network);
  const refs = findReferencedPrograms(bytecode, index, { self: programId });

  const where = and(
    eq(schema.programReferences.network, network),
    eq(schema.programReferences.fromProgramId, programId),
  );
  if (refs.length) {
    await db.insert(schema.programReferences).values(
      refs.map((to) => ({
        id: newId("ref"),
        network,
        fromProgramId: programId,
        toProgramId: to,
        fromSha256: sha256,
      })),
    ).onConflictDoUpdate({
      target: [
        schema.programReferences.network,
        schema.programReferences.fromProgramId,
        schema.programReferences.toProgramId,
      ],
      set: { fromSha256: sha256, seenAt: new Date() },
    });
    await db.delete(schema.programReferences).where(
      and(where, notInArray(schema.programReferences.toProgramId, refs)),
    );
  } else {
    await db.delete(schema.programReferences).where(where);
  }
  return refs;
}

/** Both directions for one program, named. The reverse edge is the one a
 *  dossier wants most — "who reaches for this" says more about a program's
 *  place than its own import list does. */
export interface ProgramEdges {
  names: { id: string; name: string | null; crate: string | null }[];
  namedBy: { id: string; name: string | null; crate: string | null }[];
}

export async function edgesFor(network: Network, programId: string): Promise<ProgramEdges> {
  const rows = await db
    .select({
      from: schema.programReferences.fromProgramId,
      to: schema.programReferences.toProgramId,
    })
    .from(schema.programReferences)
    .where(
      and(
        eq(schema.programReferences.network, network),
        sql`(${schema.programReferences.fromProgramId} = ${programId} or ${schema.programReferences.toProgramId} = ${programId})`,
      ),
    );
  if (!rows.length) return { names: [], namedBy: [] };

  const ids = [...new Set(rows.flatMap((r) => [r.from, r.to]))].filter((i) => i !== programId);
  const meta = ids.length
    ? await db
        .select({
          id: schema.subjects.id,
          name: schema.subjects.name,
          crate: schema.subjects.crate,
        })
        .from(schema.subjects)
        .where(and(eq(schema.subjects.network, network), inArray(schema.subjects.id, ids)))
    : [];
  const byId = new Map(meta.map((m) => [m.id, m]));
  const label = (id: string) => byId.get(id) ?? { id, name: null, crate: null };

  return {
    names: rows.filter((r) => r.from === programId).map((r) => label(r.to)),
    namedBy: rows.filter((r) => r.to === programId).map((r) => label(r.from)),
  };
}

/** Best-effort: a reference failure must never sink an event's enrichment. */
export async function tryExtractReferences(
  network: Network,
  programId: string,
  bytecode: Buffer,
  sha256: string | null,
): Promise<void> {
  try {
    const refs = await extractReferences(network, programId, bytecode, sha256);
    if (refs.length) logger.debug({ programId, refs: refs.length }, "references: extracted");
  } catch (err) {
    logger.warn({ programId, err: String(err) }, "references: extraction failed");
  }
}
