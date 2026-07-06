import { and, eq, lt, sql } from "drizzle-orm";
import { db, schema, newId, getConfig, logger, type Fingerprint } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Devnet watchlist management (spec §3). Devnet never publishes stories on its
// own — novel devnet fingerprints and their controlling keys go here, and a
// mainnet match later fires a "became real" story.
// ---------------------------------------------------------------------------

/** Record a novel devnet sighting. Noise controls: a fingerprint redeployed
 *  more than N times/day by the same key is spam, not a signal. */
export async function watchDevnetNovel(
  programId: string,
  fp: Fingerprint,
  authority: string | null,
): Promise<{ added: boolean; reason?: string }> {
  const cfg = await getConfig();
  const ttlMs = cfg.WATCHLIST_TTL_DAYS * 24 * 3_600_000;

  const existing = await db
    .select()
    .from(schema.watchlist)
    .where(and(eq(schema.watchlist.status, "active"), eq(schema.watchlist.sha256, fp.sha256)));

  if (existing[0]) {
    const item = existing[0];
    const ageDays = Math.max(1 / 24, (Date.now() - item.firstSeenAt.getTime()) / 86_400_000);
    const perDay = (item.deployCount + 1) / ageDays;
    if (perDay > cfg.DEVNET_MAX_REDEPLOYS_PER_DAY) {
      await db
        .update(schema.watchlist)
        .set({ deployCount: sql`${schema.watchlist.deployCount} + 1`, lastSeenAt: new Date() })
        .where(eq(schema.watchlist.id, item.id));
      return { added: false, reason: "redeploy_spam" };
    }
    await db
      .update(schema.watchlist)
      .set({
        deployCount: sql`${schema.watchlist.deployCount} + 1`,
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .where(eq(schema.watchlist.id, item.id));
    return { added: false, reason: "already_watching" };
  }

  await db.insert(schema.watchlist).values({
    id: newId("wl"),
    kind: "fingerprint",
    sha256: fp.sha256,
    tlsh: fp.tlsh,
    sizeBytes: fp.sizeBytes,
    authority,
    programId,
    source: "devnet_novel",
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return { added: true };
}

export async function addManualWatch(input: {
  programId?: string;
  authority?: string;
  note?: string;
  sha256?: string;
  tlsh?: string;
}): Promise<string> {
  const cfg = await getConfig();
  const id = newId("wl");
  await db.insert(schema.watchlist).values({
    id,
    kind: input.authority && !input.sha256 ? "authority" : "fingerprint",
    sha256: input.sha256 ?? null,
    tlsh: input.tlsh ?? null,
    authority: input.authority ?? null,
    programId: input.programId ?? null,
    note: input.note ?? null,
    source: "manual",
    expiresAt: new Date(Date.now() + cfg.WATCHLIST_TTL_DAYS * 24 * 3_600_000),
  });
  return id;
}

export async function markWatchlistMatched(watchlistId: string, eventId: string): Promise<void> {
  await db
    .update(schema.watchlist)
    .set({ status: "matched", matchedEventId: eventId })
    .where(eq(schema.watchlist.id, watchlistId));
}

/** Daily cron: entries with no mainnet contact for the TTL expire quietly. */
export async function expireWatchlist(): Promise<number> {
  const res = await db
    .update(schema.watchlist)
    .set({ status: "expired" })
    .where(and(eq(schema.watchlist.status, "active"), lt(schema.watchlist.expiresAt, new Date())))
    .returning({ id: schema.watchlist.id });
  if (res.length) logger.info({ count: res.length }, "watchlist entries expired");
  return res.length;
}
