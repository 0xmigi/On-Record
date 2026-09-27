import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { db, schema, logger, type Network, type VerificationBreak } from "@onrecord/core";

// ---------------------------------------------------------------------------
// What On Record remembers about verification, per version.
//
// OtterSec holds only its latest build per uploader, so the evidence that an
// older version was verified disappears from their API as soon as the team
// verifies the next one. Every match On Record sees is kept on the events
// carrying those bytes (enrichment.verification), from whichever path saw it:
// a page view, the pipeline at an upgrade, or the background sweeps.
//
// The other half is the break. When a verified program upgrades, the upgrade
// event is marked (enrichment.verificationBreak, written by identify), and the
// first time a later version is seen verified, that break is closed with the
// time it was seen (restoredSeenAt). Together they answer "when did this
// program's verification break, and how long until it came back" without
// anyone having opened the page.
// ---------------------------------------------------------------------------

/** The latest break, mirrored onto subjects.facts.verificationBreak. The
 *  events table is the big one; counting breaks across the corpus reads this. */
export interface BreakSummary {
  slot: number;
  blockTime: string | null;
  previousHash: string;
  evidence: VerificationBreak["evidence"];
  backfilled?: boolean;
  restoredSeenAt?: string;
}

export function breakSummary(brk: VerificationBreak, slot: number, blockTime: Date | null): BreakSummary {
  return {
    slot,
    blockTime: blockTime?.toISOString() ?? null,
    previousHash: brk.previousHash,
    evidence: brk.evidence,
    ...(brk.backfilled ? { backfilled: true } : {}),
  };
}

/** Mark an upgrade event as the one that broke a verification, and mirror it
 *  onto the program. identify does this through the enrichment it saves; the
 *  history sweep, which finds breaks after the fact, comes through here. */
export async function recordBreak(
  event: { id: string; programId: string; network: Network; slot: number; blockTime: Date | null },
  brk: VerificationBreak,
): Promise<void> {
  await db
    .update(schema.events)
    .set({
      enrichment: sql`jsonb_set(coalesce(${schema.events.enrichment}, '{}'::jsonb), '{verificationBreak}', ${JSON.stringify(brk)}::jsonb, true)`,
    })
    .where(eq(schema.events.id, event.id));
  await mergeBreakSummary(event.programId, event.network, breakSummary(brk, event.slot, event.blockTime));
  logger.info({ programId: event.programId, slot: event.slot, evidence: brk.evidence }, "verification break recorded");
}

async function mergeBreakSummary(programId: string, network: Network, summary: BreakSummary): Promise<void> {
  await db
    .update(schema.subjects)
    .set({
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ verificationBreak: summary })}::jsonb`,
    })
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.network, network)));
}

export interface Stamp {
  verified: true;
  repoUrl?: string;
  commit?: string;
  verifiedAt?: string | null;
  seenAt: string;
  /** which path saw it, for the logs and for anyone auditing a label */
  via: "page" | "upgrade" | "sweep";
}

/** Keep a match on every event that carries these bytes, then close any open
 *  break it resolves. Idempotent: an event already stamped keeps its first
 *  stamp. Returns how many events were newly stamped. */
export async function stampVerified(
  programId: string,
  network: Network,
  hash: string,
  label: { repoUrl?: string | null; commit?: string | null; verifiedAt?: string | null },
  via: Stamp["via"],
): Promise<number> {
  const stamp: Stamp = {
    verified: true,
    ...(label.repoUrl ? { repoUrl: label.repoUrl } : {}),
    ...(label.commit ? { commit: label.commit } : {}),
    verifiedAt: label.verifiedAt ?? null,
    seenAt: new Date().toISOString(),
    via,
  };
  const stamped = await db
    .update(schema.events)
    .set({
      enrichment: sql`jsonb_set(coalesce(${schema.events.enrichment}, '{}'::jsonb), '{verification}', ${JSON.stringify(stamp)}::jsonb, true)`,
    })
    .where(
      and(
        eq(schema.events.programId, programId),
        eq(schema.events.network, network),
        eq(schema.events.sha256After, hash),
        isNull(sql`${schema.events.enrichment}->'verification'`),
      ),
    )
    .returning({ slot: schema.events.slot });

  if (stamped.length) {
    logger.info({ programId, hash, via, events: stamped.length }, "verification stamped");
    // a stamp from the upgrade path is the OLD version being preserved as the
    // break is recorded; it can't close that same break
    if (via !== "upgrade") await closeBreak(programId, network, Math.max(...stamped.map((r) => r.slot)), stamp.seenAt);
  }
  return stamped.length;
}

/** The latest open break at or before the version now seen verified is the one
 *  it resolves. A program that upgraded twice before re-verifying has its break
 *  on the first of those upgrades; the second never broke anything, since it
 *  replaced bytes that were already unverified. */
async function closeBreak(programId: string, network: Network, slot: number, seenAt: string): Promise<void> {
  const open = await db
    .select({ id: schema.events.id, slot: schema.events.slot })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.programId, programId),
        eq(schema.events.network, network),
        lte(schema.events.slot, slot),
        sql`${schema.events.enrichment} ? 'verificationBreak'`,
        isNull(sql`${schema.events.enrichment}->'verificationBreak'->'restoredSeenAt'`),
      ),
    )
    .orderBy(desc(schema.events.slot))
    .limit(1);
  if (!open[0]) return;
  await db
    .update(schema.events)
    .set({
      enrichment: sql`jsonb_set(${schema.events.enrichment}, '{verificationBreak,restoredSeenAt}', ${JSON.stringify(seenAt)}::jsonb, true)`,
    })
    .where(eq(schema.events.id, open[0].id));
  // the program's summary follows only if it describes this same break
  await db
    .update(schema.subjects)
    .set({
      facts: sql`jsonb_set(${schema.subjects.facts}, '{verificationBreak,restoredSeenAt}', ${JSON.stringify(seenAt)}::jsonb, true)`,
    })
    .where(
      and(
        eq(schema.subjects.id, programId),
        eq(schema.subjects.network, network),
        sql`(${schema.subjects.facts}->'verificationBreak'->>'slot')::bigint = ${open[0].slot}`,
      ),
    );
  logger.info({ programId, eventId: open[0].id }, "verification break closed");
}

/** The break behind the program's current version, if its verification broke
 *  at an upgrade On Record saw and hasn't come back since. */
export async function openBreak(
  programId: string,
  network: Network,
): Promise<(VerificationBreak & { slot: number; signature: string; blockTime: string | null }) | null> {
  const rows = await db
    .select({
      slot: schema.events.slot,
      signature: schema.events.signature,
      blockTime: schema.events.blockTime,
      brk: sql<VerificationBreak>`${schema.events.enrichment}->'verificationBreak'`,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.programId, programId),
        eq(schema.events.network, network),
        sql`${schema.events.enrichment} ? 'verificationBreak'`,
      ),
    )
    .orderBy(desc(schema.events.slot))
    .limit(1);
  const r = rows[0];
  if (!r || r.brk.restoredSeenAt) return null;
  return { ...r.brk, slot: r.slot, signature: r.signature, blockTime: r.blockTime?.toISOString() ?? null };
}
