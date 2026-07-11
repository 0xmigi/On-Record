import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema, logger, programDataAlive, type Network } from "@onrecord/core";
import { refreshInterest } from "./interest.js";

// ---------------------------------------------------------------------------
// Closed-program sweep. The loader's Close instruction deallocates a program's
// ProgramData account and reclaims its rent. The live poller enumerates
// *existing* ProgramData accounts, so it never observes a close — a closed
// program simply stops appearing. We detect the absence: for recent programs we
// fingerprinted, if the ProgramData account no longer exists, the program was
// closed. We didn't see the close tx, so the label is honest: "detected closed"
// stamped at detection time, stored in facts (no schema migration needed).
//
// This is the tail of a churn pattern — a bot redeploys the same bytecode under
// a fresh id, spams failed txns, then closes to reclaim rent, and repeats.
// ---------------------------------------------------------------------------

const SWEEP_MAX = Number(process.env.CLOSED_SWEEP_MAX ?? 150);
const SWEEP_LOOKBACK_HOURS = Number(process.env.CLOSED_SWEEP_HOURS ?? 72);

export async function sweepClosed(network: Network = "mainnet"): Promise<void> {
  const since = new Date(Date.now() - SWEEP_LOOKBACK_HOURS * 3_600_000);
  // Rotation, not just recency: never-swept programs first (newest leading,
  // bots close within minutes), then the stalest-swept. A pure newest-first
  // cut starved anything older than the newest SWEEP_MAX — a 16h-old close
  // was never re-checked once ~150 newer programs existed.
  const subs = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, since),
        sql`(${schema.subjects.facts} ->> 'closedAt') is null`,
      ),
    )
    .orderBy(
      sql`${schema.subjects.facts} ->> 'closedSweepAt' asc nulls first`,
      sql`${schema.subjects.firstSeenAt} desc`,
    )
    .limit(SWEEP_MAX);

  let checked = 0;
  let closed = 0;
  const sweptAt = new Date().toISOString();
  for (const s of subs) {
    try {
      const ev = await db
        .select({ pd: schema.events.programDataAddress })
        .from(schema.events)
        .where(and(eq(schema.events.programId, s.id), isNotNull(schema.events.programDataAddress)))
        .limit(1);
      const pd = ev[0]?.pd;
      if (!pd) continue;
      checked++;
      // Alive = present + funded + state tag 3. A closed program's ProgramData
      // is NOT deleted — it survives as a 4-byte Uninitialized husk with zero
      // lamports, so a bare existence probe never detects a close. Throws on
      // RPC error, so a transient failure skips rather than false-marks.
      const alive = await programDataAlive(network, pd);
      const patch: Record<string, string> = { closedSweepAt: sweptAt };
      if (!alive) patch.closedAt = new Date().toISOString();
      await db
        .update(schema.subjects)
        .set({
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));
      if (!alive) {
        closed++;
        await refreshInterest(s.id); // closed penalty applies immediately
      }
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "closed sweep: subject failed");
    }
  }
  logger.info({ network, checked, closed, of: subs.length }, "closed sweep: done");
}
