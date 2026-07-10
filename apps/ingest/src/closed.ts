import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema, logger, accountExists, type Network } from "@onrecord/core";

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
  // recent programs not already marked closed, most-recent first (bots close
  // within minutes, so recency is where the signal is).
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
    .orderBy(desc(schema.subjects.firstSeenAt))
    .limit(SWEEP_MAX);

  let checked = 0;
  let closed = 0;
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
      // cheap existence probe (0-length dataSlice). Throws on RPC error, so a
      // transient failure skips this program rather than false-marking it.
      const exists = await accountExists(network, pd);
      if (exists) continue;
      await db
        .update(schema.subjects)
        .set({
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({
            closedAt: new Date().toISOString(),
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));
      closed++;
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "closed sweep: subject failed");
    }
  }
  logger.info({ network, checked, closed, of: subs.length }, "closed sweep: done");
}
