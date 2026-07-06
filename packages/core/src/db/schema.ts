import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// events — the append-only chain record. One row per loader instruction we
// care about. Nothing here is ever mutated except `enrichment`, which fills in
// as the pipeline runs.
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    network: text("network").notNull(), // 'mainnet' | 'devnet'
    type: text("type").notNull(), // 'deploy' | 'upgrade' | 'set_authority' | 'close'
    signature: text("signature").notNull(),
    instructionIndex: integer("instruction_index").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    programId: text("program_id").notNull(),
    programDataAddress: text("program_data_address"),
    authorityBefore: text("authority_before"),
    authorityAfter: text("authority_after"),
    sha256Before: text("sha256_before"),
    sha256After: text("sha256_after"),
    tvlAtEvent: doublePrecision("tvl_at_event"),
    // pipeline output: fingerprint, identity, classification, rank — see
    // EventEnrichment in types.ts
    enrichment: jsonb("enrichment").$type<Record<string, unknown>>().default({}).notNull(),
    pipelineStage: text("pipeline_stage").default("ingested").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("events_sig_ix_uq").on(t.signature, t.instructionIndex),
    index("events_program_idx").on(t.programId),
    index("events_network_slot_idx").on(t.network, t.slot),
  ],
);

// ---------------------------------------------------------------------------
// subjects — programs and named entities, unified. A subject is what a story
// is about. Unknown programs get a subject row keyed by program id; named
// entities can span several programs (subjects.entityKey groups them).
// ---------------------------------------------------------------------------
export const subjects = pgTable(
  "subjects",
  {
    id: text("id").primaryKey(), // programId for programs, ent_<slug> for entities
    kind: text("kind").notNull(), // 'program' | 'entity'
    network: text("network").notNull().default("mainnet"),
    name: text("name"), // display name; null until identified or operator-named
    entityKey: text("entity_key"), // groups program subjects under one entity
    verified: boolean("verified").default(false).notNull(),
    repoUrl: text("repo_url"),
    repoCommit: text("repo_commit"),
    authorityClass: text("authority_class"), // 'none' | 'squads' | 'program' | 'hot_wallet'
    authority: text("authority"),
    sha256: text("sha256"),
    tlsh: text("tlsh"),
    sizeBytes: integer("size_bytes"),
    bucketId: text("bucket_id"),
    noveltyScore: doublePrecision("novelty_score"),
    tvl: doublePrecision("tvl"),
    firstSeenSlot: bigint("first_seen_slot", { mode: "number" }),
    facts: jsonb("facts").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("subjects_entity_key_idx").on(t.entityKey), index("subjects_bucket_idx").on(t.bucketId)],
);

// ---------------------------------------------------------------------------
// copy_buckets — clusters of near-identical bytecode. Individual members never
// get stories; the bucket's velocity feeds copy-wave stories.
// ---------------------------------------------------------------------------
export const copyBuckets = pgTable("copy_buckets", {
  id: text("id").primaryKey(),
  network: text("network").notNull(),
  canonicalSha256: text("canonical_sha256").notNull(),
  canonicalTlsh: text("canonical_tlsh"),
  label: text("label"), // operator-named, e.g. "pump.fun launcher clones"
  memberCount: integer("member_count").default(1).notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  // rolling velocity stats: counts per window, updated by classify stage
  velocity: jsonb("velocity").$type<Record<string, unknown>>().default({}).notNull(),
  lastStoryAt: timestamp("last_story_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// watchlist — devnet sightings + manual watches. A mainnet match fires a
// "became real" story.
// ---------------------------------------------------------------------------
export const watchlist = pgTable(
  "watchlist",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // 'fingerprint' | 'authority'
    sha256: text("sha256"),
    tlsh: text("tlsh"),
    sizeBytes: integer("size_bytes"),
    authority: text("authority"),
    programId: text("program_id"), // devnet program id it was sighted as
    source: text("source").notNull(), // 'devnet_novel' | 'manual'
    note: text("note"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deployCount: integer("deploy_count").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").default("active").notNull(), // 'active' | 'matched' | 'expired'
    matchedEventId: text("matched_event_id"),
  },
  (t) => [index("watchlist_status_idx").on(t.status), index("watchlist_authority_idx").on(t.authority)],
);

// ---------------------------------------------------------------------------
// stories — the product. Body/facts/inference are the writer's structured
// output after passing programmatic verification.
// ---------------------------------------------------------------------------
export const stories = pgTable(
  "stories",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // 'update' | 'launch' | 'radar' | 'became_real' | 'corroboration' | 'control_change' | 'copy_wave'
    headline: text("headline").notNull(),
    body: text("body").notNull(),
    facts: jsonb("facts").$type<unknown[]>().default([]).notNull(),
    inference: jsonb("inference").$type<{ text: string; confidence: "low" | "med" | "high" } | null>(),
    subjects: jsonb("subjects").$type<string[]>().default([]).notNull(),
    eventIds: jsonb("event_ids").$type<string[]>().default([]).notNull(),
    rankScore: doublePrecision("rank_score").default(0).notNull(),
    status: text("status").default("published").notNull(), // 'published' | 'killed' | 'pinned' | 'dead_letter'
    deadLetterReason: text("dead_letter_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("stories_status_published_idx").on(t.status, t.publishedAt), index("stories_type_idx").on(t.type)],
);

// ---------------------------------------------------------------------------
// digests — one per day: top stories + counts.
// ---------------------------------------------------------------------------
export const digests = pgTable("digests", {
  date: text("date").primaryKey(), // YYYY-MM-DD (ET per spec default)
  storyIds: jsonb("story_ids").$type<string[]>().default([]).notNull(),
  counts: jsonb("counts").$type<Record<string, number>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// operator_log — every lever pull. Edits are part of the record.
// ---------------------------------------------------------------------------
export const operatorLog = pgTable("operator_log", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// config — runtime-tunable thresholds, weights, budgets, tone notes.
// Single-row-per-key string/json store.
// ---------------------------------------------------------------------------
export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// fingerprint_corpus — append-only fingerprint history used for the linear
// TLSH nearest-neighbor scan.
// ---------------------------------------------------------------------------
export const fingerprintCorpus = pgTable(
  "fingerprint_corpus",
  {
    id: text("id").primaryKey(),
    programId: text("program_id").notNull(),
    network: text("network").notNull(),
    sha256: text("sha256").notNull(),
    tlsh: text("tlsh"),
    sizeBytes: integer("size_bytes").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("corpus_sha_idx").on(t.sha256),
    index("corpus_network_size_idx").on(t.network, t.sizeBytes),
  ],
);

// ---------------------------------------------------------------------------
// entities — the identity registry seeded from DeFiLlama / labels.yaml.
// Maps program ids to named entities.
// ---------------------------------------------------------------------------
export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(), // ent_<slug>
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    category: text("category"),
    website: text("website"),
    llamaSlug: text("llama_slug"), // DeFiLlama protocol slug for TVL refresh
    programIds: jsonb("program_ids").$type<string[]>().default([]).notNull(),
    authorities: jsonb("authorities").$type<string[]>().default([]).notNull(),
    tvl: doublePrecision("tvl"),
    tvlUpdatedAt: timestamp("tvl_updated_at", { withTimezone: true }),
    source: text("source").default("labels").notNull(), // 'labels' | 'defillama' | 'operator'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("entities_slug_uq").on(t.slug)],
);
