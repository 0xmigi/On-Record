import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  db,
  schema,
  enqueue,
  getQueue,
  getAccountBytes,
  parseProgramDataAccount,
  sha256Hex,
  tlshHash,
  extractStrings,
  probeAnchorIdl,
  newId,
  stageLogger,
  getConfig,
  type EventEnrichment,
  type Fingerprint,
  type Network,
  type StoryDraft,
  type StoryType,
  type VerifyJob,
  type WriteJob,
} from "@onrecord/core";
import {
  appendToCorpus,
  bucketVelocity,
  checkVerification,
  classifyAuthority,
  classifyFingerprint,
  findEntityForAuthority,
  findEntityForProgram,
  markWatchlistMatched,
  watchDevnetNovel,
} from "@onrecord/enrich";
import {
  checkBudget,
  getDiffSummary,
  rankEvent,
  verifyStory,
  writeStory,
  type FactPack,
} from "@onrecord/newsroom";

type EventRow = typeof schema.events.$inferSelect;

async function loadEvent(eventId: string): Promise<EventRow> {
  const rows = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  if (!rows[0]) throw new Error(`event not found: ${eventId}`);
  return rows[0];
}

async function saveEnrichment(eventId: string, enrichment: EventEnrichment, stage: string): Promise<void> {
  await db
    .update(schema.events)
    .set({ enrichment: enrichment as Record<string, unknown>, pipelineStage: stage })
    .where(eq(schema.events.id, eventId));
}

function enrichmentOf(event: EventRow): EventEnrichment {
  return (event.enrichment ?? {}) as EventEnrichment;
}

// ---------------------------------------------------------------------------
// Stage 1 — fingerprint (spec §4.1)
// ---------------------------------------------------------------------------

export async function fingerprintStage(eventId: string): Promise<void> {
  const log = stageLogger("fingerprint");
  const start = Date.now();
  const event = await loadEvent(eventId);
  const enrichment = enrichmentOf(event);
  const network = event.network as Network;

  // set_authority / close carry no bytecode — resolve the program id from the
  // record (prior deploy/upgrade rows share the ProgramData address) and move on.
  if (event.type === "set_authority" || event.type === "close") {
    if (!event.programId || event.programId === "unknown") {
      const resolved = event.programDataAddress
        ? await resolveProgramId(network, event.programDataAddress)
        : null;
      if (resolved) {
        await db.update(schema.events).set({ programId: resolved }).where(eq(schema.events.id, eventId));
      }
    }
    await saveEnrichment(eventId, enrichment, "fingerprinted");
    await enqueue("identify", { eventId });
    log.info({ eventId, ms: Date.now() - start, outcome: "no_bytecode" }, "done");
    return;
  }

  // Spam defense (spec §8): under backlog, authorities spraying deploys are
  // bucketed by authority without fetching bytes.
  const backlog = await getQueue("fingerprint").getWaitingCount();
  if (backlog > 200 && event.authorityAfter) {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.network, event.network),
          eq(schema.events.authorityAfter, event.authorityAfter),
          gte(schema.events.createdAt, hourAgo),
        ),
      );
    if (Number(recent[0]?.n ?? 0) > 10) {
      enrichment.skippedSpamWave = true;
      await saveEnrichment(eventId, enrichment, "skipped_spam_wave");
      log.info({ eventId, authority: event.authorityAfter, outcome: "skipped_spam_wave" }, "done");
      return;
    }
  }

  const address = event.programDataAddress;
  if (!address) throw new Error("deploy/upgrade event without ProgramData address");
  const raw = await getAccountBytes(network, address);
  if (!raw) {
    enrichment.error = "programdata account not found (closed already?)";
    await saveEnrichment(eventId, enrichment, "fingerprint_failed");
    log.warn({ eventId, outcome: "account_missing" }, "done");
    return;
  }
  const parsed = parseProgramDataAccount(raw);
  if (!parsed) {
    enrichment.error = "account is not a ProgramData account";
    await saveEnrichment(eventId, enrichment, "fingerprint_failed");
    return;
  }

  const fp: Fingerprint = {
    sha256: sha256Hex(parsed.bytecode),
    tlsh: await tlshHash(parsed.bytecode),
    sizeBytes: parsed.bytecode.length,
    idl: event.programId ? await probeAnchorIdl(network, event.programId) : null,
    strings: extractStrings(parsed.bytecode),
  };
  enrichment.fingerprint = fp;

  await db
    .update(schema.events)
    .set({
      enrichment: enrichment as Record<string, unknown>,
      pipelineStage: "fingerprinted",
      sha256After: fp.sha256,
      authorityAfter: event.authorityAfter ?? parsed.upgradeAuthority,
    })
    .where(eq(schema.events.id, eventId));

  await enqueue("identify", { eventId });
  log.info({ eventId, ms: Date.now() - start, sizeBytes: fp.sizeBytes, outcome: "ok" }, "done");
}

async function resolveProgramId(network: Network, programDataAddress: string): Promise<string | null> {
  const rows = await db
    .select({ programId: schema.events.programId })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        eq(schema.events.programDataAddress, programDataAddress),
        isNotNull(schema.events.programId),
        sql`${schema.events.programId} != 'unknown'`,
      ),
    )
    .orderBy(desc(schema.events.slot))
    .limit(1);
  return rows[0]?.programId ?? null;
}

// ---------------------------------------------------------------------------
// Stage 2 — identify (spec §4.2)
// ---------------------------------------------------------------------------

export async function identifyStage(eventId: string): Promise<void> {
  const log = stageLogger("identify");
  const start = Date.now();
  const event = await loadEvent(eventId);
  const enrichment = enrichmentOf(event);
  const network = event.network as Network;
  const programId = event.programId && event.programId !== "unknown" ? event.programId : null;

  const entity = programId ? await findEntityForProgram(programId) : null;
  const entityByAuthority =
    !entity && event.authorityAfter ? await findEntityForAuthority(event.authorityAfter) : null;

  const verification = programId
    ? await checkVerification(programId, { bustCache: event.type === "upgrade" })
    : { verified: false, repoUrl: null, commit: null };

  // previous commit for the diff: whatever the subject row knew before this event
  const subjectRows = programId
    ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId))
    : [];
  const previousCommit = subjectRows[0]?.repoCommit ?? null;

  const authorityClass = await classifyAuthority(network, event.authorityAfter);

  enrichment.identity = {
    entityId: entity?.id ?? entityByAuthority?.id ?? null,
    entityName: entity?.name ?? entityByAuthority?.name ?? null,
    verified: verification.verified,
    repoUrl: verification.repoUrl,
    repoCommit: verification.commit,
    previousCommit,
    authorityClass,
    tvl: entity?.tvl ?? null,
  };

  await db
    .update(schema.events)
    .set({
      enrichment: enrichment as Record<string, unknown>,
      pipelineStage: "identified",
      tvlAtEvent: entity?.tvl ?? null,
    })
    .where(eq(schema.events.id, eventId));

  if (programId) await upsertSubject(event, enrichment);

  await enqueue("classify", { eventId });
  log.info({ eventId, ms: Date.now() - start, entity: enrichment.identity.entityName, outcome: "ok" }, "done");
}

async function upsertSubject(event: EventRow, enrichment: EventEnrichment): Promise<void> {
  const fp = enrichment.fingerprint;
  const id = enrichment.identity;
  const values = {
    kind: "program" as const,
    network: event.network,
    name: id?.entityName ?? null,
    entityKey: id?.entityId ?? null,
    verified: id?.verified ?? false,
    repoUrl: id?.repoUrl ?? null,
    repoCommit: id?.repoCommit ?? null,
    authorityClass: id?.authorityClass ?? null,
    authority: event.authorityAfter,
    sha256: fp?.sha256 ?? null,
    tlsh: fp?.tlsh ?? null,
    sizeBytes: fp?.sizeBytes ?? null,
    tvl: id?.tvl ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.subjects)
    .values({ id: event.programId, firstSeenSlot: event.slot, ...values })
    .onConflictDoUpdate({
      target: schema.subjects.id,
      set: {
        ...values,
        // never un-name a subject the operator or registry already named
        name: sql`coalesce(${schema.subjects.name}, ${values.name})`,
      },
    });
}

// ---------------------------------------------------------------------------
// Stage 3 — classify (spec §4.3)
// ---------------------------------------------------------------------------

export async function classifyStage(eventId: string): Promise<void> {
  const log = stageLogger("classify");
  const start = Date.now();
  const event = await loadEvent(eventId);
  const enrichment = enrichmentOf(event);
  const network = event.network as Network;
  const fp = enrichment.fingerprint;

  if (event.type === "deploy" && fp) {
    const classification = await classifyFingerprint(network, event.programId, fp);
    enrichment.classification = classification;

    if (classification.bucketId) {
      await db
        .update(schema.subjects)
        .set({ bucketId: classification.bucketId, noveltyScore: classification.noveltyScore })
        .where(eq(schema.subjects.id, event.programId));
    } else {
      await db
        .update(schema.subjects)
        .set({ noveltyScore: classification.noveltyScore })
        .where(eq(schema.subjects.id, event.programId));
    }

    if (classification.watchlistHit) {
      await markWatchlistMatched(classification.watchlistHit.watchlistId, eventId);
    }

    // Devnet is input only (spec §3): novel devnet fingerprints go to the
    // watchlist and the pipeline stops here.
    if (network === "devnet") {
      if (classification.disposition === "novel") {
        await watchDevnetNovel(event.programId, fp, event.authorityAfter);
      }
      await appendToCorpus(network, event.programId, fp);
      await saveEnrichment(eventId, enrichment, "classified_devnet");
      log.info({ eventId, ms: Date.now() - start, outcome: "devnet_recorded" }, "done");
      return;
    }
  }

  if (fp) await appendToCorpus(network, event.programId, fp);
  await saveEnrichment(eventId, enrichment, "classified");

  if (network === "devnet") {
    log.info({ eventId, outcome: "devnet_recorded" }, "done");
    return; // devnet never publishes on its own
  }

  await enqueue("rank", { eventId });
  log.info({ eventId, ms: Date.now() - start, outcome: "ok" }, "done");
}

// ---------------------------------------------------------------------------
// Stage 4 — rank (spec §4.4)
// ---------------------------------------------------------------------------

export async function rankStage(eventId: string): Promise<void> {
  const log = stageLogger("rank");
  const start = Date.now();
  const event = await loadEvent(eventId);
  const enrichment = enrichmentOf(event);

  const rank = await rankEvent({
    eventType: event.type as "deploy" | "upgrade" | "set_authority" | "close",
    enrichment,
    hasAnnouncement: Boolean(enrichment.announcementUrl),
  });
  enrichment.rank = rank;

  if (!rank.storyType) {
    await saveEnrichment(eventId, enrichment, "ranked_data_only");
    log.info({ eventId, score: rank.score, outcome: "data_only" }, "done");
    return;
  }

  const budget = await checkBudget(rank.storyType, rank.score);
  if (!budget.allowed) {
    await saveEnrichment(eventId, enrichment, `ranked_below_line:${budget.reason}`);
    log.info({ eventId, score: rank.score, outcome: budget.reason }, "done");
    return;
  }

  // Verified update: fetch the code diff so the writer can say what changed.
  const id = enrichment.identity;
  if (
    rank.storyType === "update" &&
    id?.verified &&
    id.repoUrl &&
    id.repoCommit &&
    id.previousCommit &&
    id.repoCommit !== id.previousCommit
  ) {
    enrichment.diffSummary =
      (await getDiffSummary(id.repoUrl, id.previousCommit, id.repoCommit)) ?? undefined;
  }

  await saveEnrichment(eventId, enrichment, "ranked_story");
  await enqueue("write", { eventId, storyType: rank.storyType } satisfies WriteJob);
  log.info({ eventId, score: rank.score, storyType: rank.storyType, outcome: "story_job" }, "done");
}

// ---------------------------------------------------------------------------
// Stage 5 — write (spec §4.5)
// ---------------------------------------------------------------------------

export async function writeStage(job: WriteJob): Promise<void> {
  const log = stageLogger("write");
  const start = Date.now();
  const pack = await buildFactPack(job);
  const draft = await writeStory(pack, job.rewriteErrors);
  await enqueue("verify", {
    eventId: job.eventId,
    storyType: job.storyType,
    draft,
    attempt: job.rewriteErrors ? 2 : 1,
    bucketId: job.bucketId,
    announcementUrl: job.announcementUrl,
    programId: job.programId,
  } satisfies VerifyJob);
  log.info({ eventId: job.eventId, ms: Date.now() - start, attempt: job.rewriteErrors ? 2 : 1 }, "done");
}

export async function buildFactPack(job: WriteJob): Promise<FactPack> {
  const event = job.eventId ? await loadEvent(job.eventId) : null;
  const enrichment = event ? enrichmentOf(event) : {};
  const id = enrichment.identity;
  const fp = enrichment.fingerprint;
  const cls = enrichment.classification;
  const programId = job.programId ?? event?.programId ?? null;

  const receipts: FactPack["candidateReceipts"] = [];
  if (event) {
    receipts.push({
      kind: "tx",
      ref: event.signature,
      describes: `the transaction where this ${event.type === "deploy" ? "launch" : event.type === "upgrade" ? "update" : "change"} happened`,
    });
  }
  if (programId) {
    receipts.push({ kind: "account", ref: programId, describes: "the app itself on chain" });
  }
  if (id?.verified && id.repoUrl) {
    const commitUrl = id.repoCommit ? `${id.repoUrl.replace(/\/$/, "")}/commit/${id.repoCommit}` : id.repoUrl;
    receipts.push({ kind: "repo", ref: commitUrl, describes: "the public code this matches" });
  }
  const announcementUrl = job.announcementUrl ?? enrichment.announcementUrl ?? null;
  if (announcementUrl) {
    receipts.push({ kind: "repo", ref: announcementUrl, describes: "the announcement being checked" });
  }

  // became_real: pull the watchlist history for the lifecycle framing
  let watchlistInfo: FactPack["watchlist"] = null;
  if (cls?.watchlistHit) {
    const rows = await db
      .select()
      .from(schema.watchlist)
      .where(eq(schema.watchlist.id, cls.watchlistHit.watchlistId));
    if (rows[0]) {
      watchlistInfo = {
        firstSeenAt: rows[0].firstSeenAt.toISOString(),
        lastSeenAt: rows[0].lastSeenAt.toISOString(),
        deployCount: rows[0].deployCount,
      };
    }
  }

  // copy_wave: bucket stats instead of single-event facts
  let copyWave: FactPack["copyWave"] = null;
  if (job.bucketId) {
    const rows = await db.select().from(schema.copyBuckets).where(eq(schema.copyBuckets.id, job.bucketId));
    if (rows[0]) {
      copyWave = {
        count6h: bucketVelocity(rows[0].velocity, 6),
        bucketLabel: rows[0].label,
        memberCount: rows[0].memberCount,
      };
    }
  }

  const subjectIds = [programId ?? job.bucketId ?? "the-record"];

  return {
    storyType: job.storyType,
    network: event?.network ?? "mainnet",
    eventType: event?.type ?? "deploy",
    when: event?.blockTime?.toISOString() ?? null,
    subjectIds,
    subjectName: id?.entityName ?? null,
    entityName: id?.entityName ?? null,
    verified: id?.verified ?? false,
    repoUrl: id?.repoUrl ?? null,
    authorityClassBefore: null,
    authorityClass: id?.authorityClass ?? null,
    tvl: id?.tvl ?? null,
    noveltyScore: cls?.noveltyScore ?? null,
    idlInstructions: fp?.idl?.instructions ?? [],
    topStrings: (fp?.strings ?? []).slice(0, 25),
    diffSummary: enrichment.diffSummary ?? null,
    watchlist: watchlistInfo,
    copyWave,
    announcementUrl,
    candidateReceipts: receipts,
  };
}

// ---------------------------------------------------------------------------
// Stage 6 — verify (spec §4.6)
// ---------------------------------------------------------------------------

export async function verifyStage(job: VerifyJob): Promise<void> {
  const log = stageLogger("verify");
  const start = Date.now();
  const draft = job.draft as StoryDraft;
  const event = job.eventId ? await loadEvent(job.eventId) : null;
  const enrichment = event ? enrichmentOf(event) : {};

  const pack = await buildFactPack({
    eventId: job.eventId,
    storyType: job.storyType,
    bucketId: job.bucketId,
    announcementUrl: job.announcementUrl,
    programId: job.programId,
  });

  const knownNumbers: number[] = [];
  if (enrichment.identity?.tvl) knownNumbers.push(enrichment.identity.tvl);
  if (pack.copyWave) knownNumbers.push(pack.copyWave.count6h, pack.copyWave.memberCount);
  if (pack.watchlist) {
    knownNumbers.push(pack.watchlist.deployCount);
    knownNumbers.push((Date.now() - Date.parse(pack.watchlist.firstSeenAt)) / 86_400_000); // days in the lab
  }

  const result = await verifyStory(draft, {
    network: (event?.network as "mainnet" | "devnet") ?? "mainnet",
    allowedReceipts: pack.candidateReceipts,
    knownNumbers,
  });

  if (result.ok) {
    await publishStory(draft, job, event?.id ?? null, enrichment.rank?.score ?? 0);
    log.info({ eventId: job.eventId, ms: Date.now() - start, outcome: "published" }, "done");
    return;
  }

  if (job.attempt < 2) {
    // one rewrite attempt with the errors fed back (spec §4.6)
    await enqueue("write", {
      eventId: job.eventId,
      storyType: job.storyType,
      bucketId: job.bucketId,
      announcementUrl: job.announcementUrl,
      programId: job.programId,
      rewriteErrors: result.errors,
    } satisfies WriteJob);
    log.warn({ eventId: job.eventId, errors: result.errors, outcome: "rewrite" }, "done");
    return;
  }

  // second failure → dead-letter for the operator
  await db.insert(schema.stories).values({
    id: newId("sty"),
    type: draft.type,
    headline: draft.headline,
    body: draft.body,
    facts: draft.facts,
    inference: draft.inference,
    subjects: draft.subjects,
    eventIds: event ? [event.id] : [],
    rankScore: enrichment.rank?.score ?? 0,
    status: "dead_letter",
    deadLetterReason: result.errors.join("; "),
    publishedAt: null,
  });
  log.error({ eventId: job.eventId, errors: result.errors, outcome: "dead_letter" }, "done");
}

async function publishStory(
  draft: StoryDraft,
  job: VerifyJob,
  eventId: string | null,
  rankScore: number,
): Promise<void> {
  await db.insert(schema.stories).values({
    id: newId("sty"),
    type: draft.type,
    headline: draft.headline,
    body: draft.body,
    facts: draft.facts,
    inference: draft.inference,
    subjects: draft.subjects,
    eventIds: eventId ? [eventId] : [],
    rankScore,
    status: "published",
    publishedAt: new Date(),
  });
  if (job.bucketId) {
    await db
      .update(schema.copyBuckets)
      .set({ lastStoryAt: new Date() })
      .where(eq(schema.copyBuckets.id, job.bucketId));
  }
}

// ---------------------------------------------------------------------------
// Copy-wave sweep (spec §1.4): aggregate stories only. Called by cron; finds
// buckets moving fast enough and enqueues one story job per bucket.
// ---------------------------------------------------------------------------

export async function copyWaveSweep(): Promise<number> {
  const cfg = await getConfig();
  const buckets = await db
    .select()
    .from(schema.copyBuckets)
    .where(eq(schema.copyBuckets.network, "mainnet"));

  let enqueued = 0;
  for (const bucket of buckets) {
    const v6 = bucketVelocity(bucket.velocity, 6);
    if (v6 < 20) continue; // needs a real wave, not a trickle
    if (bucket.lastStoryAt && Date.now() - bucket.lastStoryAt.getTime() < 6 * 3_600_000) continue;

    const budget = await checkBudget("copy_wave", 1);
    if (!budget.allowed) break;

    // anchor the story on the bucket's most recent member event
    const recent = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.network, "mainnet"), eq(schema.events.type, "deploy")))
      .orderBy(desc(schema.events.createdAt))
      .limit(200);
    const member = recent.find(
      (e) => (enrichmentOf(e).classification?.bucketId ?? null) === bucket.id,
    );
    if (!member) continue;

    await enqueue("write", {
      eventId: member.id,
      storyType: "copy_wave",
      bucketId: bucket.id,
    } satisfies WriteJob);
    enqueued++;
  }
  void cfg;
  return enqueued;
}
