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
  stageLogger,
  getConfig,
  getFundingSource,
  getEarlyActivity,
  getDeployHistory,
  profileProgram,
  deriveBytecodeIdentity,
  type Category,
  type EventEnrichment,
  type Fingerprint,
  type Network,
  type ScoreResult,
} from "@onrecord/core";
import {
  appendToCorpus,
  categorize,
  checkVerification,
  classifyAuthority,
  classifyFingerprint,
  findEntityForAuthority,
  findEntityForProgram,
  markWatchlistMatched,
  watchDevnetNovel,
} from "@onrecord/enrich";

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
// Stage 1 — fingerprint (SPEC §3): pull ProgramData bytes, hash + TLSH + IDL.
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

  // Spam defense (SPEC §10): under backlog, authorities spraying deploys are
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

  // structured profile from the SBF bytecode: framework, syscalls, capabilities,
  // integrations (docs/GRADING.md §5). Feeds the radar's framework chip + the
  // eventual grading axes.
  enrichment.profile = profileProgram(parsed.bytecode, {
    strings: fp.strings,
    idlInstructions: fp.idl?.instructions,
  });

  // recovered identity from the binary: name (Rust panic paths / security.txt),
  // repo, socials, website — de-opaques ~half of anonymous programs.
  enrichment.bytecodeIdentity = deriveBytecodeIdentity(parsed.bytecode);

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
// Stage 2 — identify (SPEC §3): entity registry, verified builds, authority.
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

  const subjectRows = programId
    ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId))
    : [];
  const previousCommit = subjectRows[0]?.repoCommit ?? null;

  const authorityClass = await classifyAuthority(network, event.authorityAfter);

  // deploy vs upgrade: read the ProgramData deploy history (its signatures are
  // deploy/upgrade txns only). >1 tx ⇒ the program existed and was re-deployed.
  if (event.programDataAddress) {
    const dh = await getDeployHistory(network, event.programDataAddress);
    const upgradeCount = Math.max(0, dh.txCount - 1);
    enrichment.deploy = {
      firstDeployAt: dh.firstDeployAt?.toISOString() ?? null,
      deployType: upgradeCount > 0 ? "upgrade" : "deploy",
      upgradeCount,
    };
  }

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

  await saveEnrichment(eventId, enrichment, "identified");
  if (programId) await upsertSubject(event, enrichment);

  await enqueue("classify", { eventId });
  log.info({ eventId, ms: Date.now() - start, entity: enrichment.identity.entityName, outcome: "ok" }, "done");
}

async function upsertSubject(event: EventRow, enrichment: EventEnrichment): Promise<void> {
  const fp = enrichment.fingerprint;
  const id = enrichment.identity;
  const bi = enrichment.bytecodeIdentity;
  const dep = enrichment.deploy;
  const when = event.blockTime ?? new Date();
  const values = {
    kind: "program" as const,
    network: event.network,
    // registry/entity name wins; else the name recovered from the binary
    name: id?.entityName ?? bi?.name ?? null,
    entityKey: id?.entityId ?? null,
    verified: id?.verified ?? false,
    // verified-build repo wins; else a repo URL found in the binary
    repoUrl: id?.repoUrl ?? bi?.repoUrl ?? null,
    repoCommit: id?.repoCommit ?? null,
    authorityClass: id?.authorityClass ?? null,
    authority: event.authorityAfter,
    sha256: fp?.sha256 ?? null,
    tlsh: fp?.tlsh ?? null,
    sizeBytes: fp?.sizeBytes ?? null,
    profile: enrichment.profile ?? null,
    firstDeployAt: dep?.firstDeployAt ? new Date(dep.firstDeployAt) : null,
    deployType: dep?.deployType ?? null,
    facts: {
      ...(bi ? { social: bi.social, website: bi.website, hasSecurityTxt: bi.hasSecurityTxt, anchor: bi.anchor } : {}),
      ...(dep ? { upgradeCount: dep.upgradeCount } : {}),
    },
    tvl: id?.tvl ?? null,
    lastEventAt: when,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.subjects)
    .values({ id: event.programId, firstSeenSlot: event.slot, firstSeenAt: when, ...values })
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
// Stage 3 — classify (SPEC §2, the gate): dedup → band + bucket.
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

    await db
      .update(schema.subjects)
      .set({ bucketId: classification.bucketId, noveltyBand: classification.band })
      .where(eq(schema.subjects.id, event.programId));

    if (classification.watchlistHit) {
      await markWatchlistMatched(classification.watchlistHit.watchlistId, eventId);
    }

    // Devnet is input only (SPEC §3): novel devnet fingerprints go to the
    // watchlist and the pipeline stops here.
    if (network === "devnet") {
      if (classification.band === "novel") {
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
    return; // devnet never surfaces on the mainnet radar
  }

  await enqueue("score", { eventId });
  log.info({ eventId, ms: Date.now() - start, band: enrichment.classification?.band, outcome: "ok" }, "done");
}

// ---------------------------------------------------------------------------
// Stage 4 — score (SPEC §2): composite novelty. The radar ranks on this.
// ---------------------------------------------------------------------------

export async function scoreStage(eventId: string): Promise<void> {
  const log = stageLogger("score");
  const start = Date.now();
  const event = await loadEvent(eventId);
  const enrichment = enrichmentOf(event);
  const network = event.network as Network;
  const cfg = await getConfig();
  const w = cfg.noveltyWeights;

  const fp = enrichment.fingerprint;
  const id = enrichment.identity;
  const cls = enrichment.classification;

  const band = cls?.band ?? "variant";
  const structural = cls?.structuralNovelty ?? 0;
  const idlPresent = Boolean(fp?.idl);
  const instructionCount = fp?.idl?.instructions.length ?? null;
  const category: Category = categorize(fp, id);

  // funding trail is an RPC walk — only worth it for novel candidates
  const fundingSource =
    band === "novel" ? await getFundingSource(network, event.authorityAfter) : null;

  // early usage is lagging; measured now (may be ~0 fresh off the deploy) and
  // refreshed by the cron re-rank as traffic arrives.
  const deployedAtMs = (event.blockTime ?? new Date()).getTime();
  const earlySigners =
    band === "novel"
      ? await getEarlyActivity(network, event.programId, deployedAtMs, cfg.EARLY_USAGE_WINDOW_HOURS)
      : null;

  const components = {
    structural: structural * w.structural,
    instructionSurface: Math.min(1, (instructionCount ?? 0) / 30) * w.instructionSurface,
    fundingTrail: fundingScore(fundingSource) * w.fundingTrail,
    authority: authorityScore(id?.authorityClass ?? null) * w.authority,
    earlyUsage: Math.min(1, (earlySigners ?? 0) / 50) * w.earlyUsage,
    verified: (id?.verified ? 1 : 0) * w.verified,
  };
  const weightSum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const score = Object.values(components).reduce((a, b) => a + b, 0) / weightSum;

  const result: ScoreResult = {
    score,
    category,
    instructionCount,
    idlPresent,
    fundingSource,
    earlySigners,
    components,
  };
  enrichment.score = result;

  await db
    .update(schema.subjects)
    .set({
      noveltyBand: band,
      noveltyScore: score,
      category,
      instructionCount,
      idlPresent,
      deployerFundingSource: fundingSource,
      earlySigners,
      lastEventAt: event.blockTime ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.subjects.id, event.programId));

  await saveEnrichment(eventId, enrichment, "scored");
  log.info(
    { eventId, ms: Date.now() - start, band, score: score.toFixed(3), category, outcome: "ok" },
    "done",
  );
}

/** Deploy authority funding → credibility signal. */
function fundingScore(source: ScoreResult["fundingSource"]): number {
  switch (source) {
    case "known_multisig":
      return 1;
    case "cex":
      return 0.8;
    case "bridge":
      return 0.7;
    case "fresh":
      return 0.25;
    default:
      return 0; // unknown / null
  }
}

/** Authority structure → intent signal. */
function authorityScore(authorityClass: string | null): number {
  switch (authorityClass) {
    case "squads":
      return 1; // multisig
    case "none":
      return 0.8; // immutable / frozen
    case "program":
      return 0.6; // controlled by another program (governance-ish)
    case "hot_wallet":
      return 0.2;
    default:
      return 0;
  }
}
