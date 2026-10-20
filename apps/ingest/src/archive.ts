import { and, desc, eq, notExists, or, sql } from "drizzle-orm";
import { db, loadHistory, schema } from "@onrecord/core";
import { historyEvents } from "./history-events.js";
import { serializeEvent } from "./serialize.js";

// ---------------------------------------------------------------------------
// Programs known only from the archive — deployed, upgraded or closed since
// 2023-07-18 but never seen live, so no `subjects` row. Most were closed again
// (49,866 of 69,162 in the index). Search reads the small index table; a page
// reads the program's history from R2. Neither scans anything else.
// ---------------------------------------------------------------------------

export type ApiArchivedProgram = {
  id: string;
  name: string | null;
  framework: string;
  firstDeployAt: string | null;
  lastChangeAt: string | null;
  versions: number;
  upgrades: number;
  closedAt: string | null;
  deployer: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function serialize(r: typeof schema.historyPrograms.$inferSelect): ApiArchivedProgram {
  return {
    id: r.programId,
    name: r.name,
    framework: r.framework,
    firstDeployAt: iso(r.firstDeployAt),
    lastChangeAt: iso(r.lastChangeAt),
    versions: r.versions,
    upgrades: r.upgrades,
    closedAt: iso(r.closedAt),
    deployer: r.deployer,
  };
}

// only programs On Record has no live page for — the rest already search
const unseen = notExists(
  db.select({ one: sql`1` }).from(schema.subjects).where(eq(schema.subjects.id, schema.historyPrograms.programId)),
);

/** archive programs matching an address or a name fragment */
export async function searchArchive(raw: string, limit: number): Promise<ApiArchivedProgram[]> {
  const q = raw.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select()
    .from(schema.historyPrograms)
    .where(
      and(
        unseen,
        or(
          eq(schema.historyPrograms.programId, raw),
          sql`lower(${schema.historyPrograms.name}) like ${`%${q}%`}`,
          sql`lower(${schema.historyPrograms.programId}) like ${`${q}%`}`,
        )!,
      ),
    )
    .orderBy(desc(schema.historyPrograms.lastChangeAt))
    .limit(limit);
  return rows.map(serialize);
}

/** one archive-only program: its index row, its record, and where it ends */
export async function archiveDetail(id: string) {
  const [[row], history] = await Promise.all([
    db.select().from(schema.historyPrograms).where(eq(schema.historyPrograms.programId, id)),
    loadHistory(id),
  ]);
  if (!row || !history) return null;
  const deploy = history.first_deploy;
  const latest = history.versions.at(-1);
  return {
    ...serialize(row),
    programDataAddress: history.programdata,
    authority: row.authority,
    sizeBytes: latest?.size ?? null,
    sha256: latest?.sha256 ?? null,
    crate: history.versions.map((v) => v.crate).filter(Boolean).at(-1) ?? null,
    instructionNames: latest?.instructionNames ?? [],
    integrations: latest?.integrations ?? [],
    firstDeploySignature: deploy?.signature ?? null,
    closedSignature: history.closed?.signature ?? null,
    coverage: history.coverage,
    events: historyEvents(history)
      .sort((a, b) => b.slot - a.slot)
      .map(serializeEvent),
  };
}
