import { sql } from "drizzle-orm";
import {
  bigint,
  primaryKey,
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
    // pipeline output: fingerprint, identity, classification, score — see
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
// subjects — programs and named entities, unified. A subject is what the radar
// ranks. Unknown programs get a subject row keyed by program id; named
// entities can span several programs (subjects.entityKey groups them).
// The radar reads directly off this table.
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
    // --- novelty / radar fields (SPEC §2, §4) ---
    noveltyBand: text("novelty_band"), // 'clone' | 'variant' | 'novel'
    noveltyScore: doublePrecision("novelty_score"), // 0..1 composite
    category: text("category"), // 'defi' | 'token' | 'nft' | 'infra' | 'governance' | 'unknown'
    instructionCount: integer("instruction_count"),
    idlPresent: boolean("idl_present").default(false).notNull(),
    // structured profile from the SBF bytecode (framework, syscalls, caps, integrations)
    profile: jsonb("profile").$type<import("../profile.js").ProgramProfile>(),
    // deploy vs upgrade: firstDeployAt = the ORIGINAL deploy (from ProgramData history);
    // deployType 'upgrade' = the program existed and was re-deployed (not new).
    firstDeployAt: timestamp("first_deploy_at", { withTimezone: true }),
    deployType: text("deploy_type"), // 'deploy' | 'upgrade'
    deployerFundingSource: text("deployer_funding_source"),
    earlySigners: integer("early_signers"),
    tvl: doublePrecision("tvl"),
    firstSeenSlot: bigint("first_seen_slot", { mode: "number" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    facts: jsonb("facts").$type<Record<string, unknown>>().default({}).notNull(),
    // flat lowercased search corpus: declared identity + denoised bytecode
    // strings. Matched with trigram ILIKE — see search.ts for why not tsvector.
    searchText: text("search_text"),
    // source tree recovered from panic paths (sourcetree.ts). `crate` is the
    // workspace crate name; `sourcePaths` its own .rs files. This is the fork
    // signal TLSH cannot see — same source, different build.
    crate: text("crate"),
    sourcePaths: jsonb("source_paths").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("subjects_entity_key_idx").on(t.entityKey),
    index("subjects_bucket_idx").on(t.bucketId),
    index("subjects_radar_idx").on(t.network, t.noveltyBand, t.noveltyScore),
    index("subjects_first_seen_idx").on(t.firstSeenAt),
    // the upgrade stream: "programs whose code changed in this window", dated by
    // lastEventAt rather than firstSeenAt. Expression-indexed because the query
    // coalesces to firstSeenAt for rows that predate lastEventAt.
    index("subjects_upgraded_idx").on(
      t.network,
      t.deployType,
      sql`coalesce(${t.lastEventAt}, ${t.firstSeenAt}) desc`,
    ),
    // lineage-by-crate: the lookup is "who else compiled from this crate"
    index("subjects_crate_idx").on(t.network, t.crate),
  ],
);

// ---------------------------------------------------------------------------
// poll_cursors — one row per network: the highest slot the poller has fully
// ingested. Everything at or below `slot` is on record; the cursor never
// advances past a program whose pipeline failed, so transient errors are
// retried on the next tick instead of being silently skipped forever.
// ---------------------------------------------------------------------------
export const pollCursors = pgTable("poll_cursors", {
  network: text("network").primaryKey(),
  slot: bigint("slot", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// copy_buckets — clusters of near-identical bytecode. Individual members are
// folded into the cluster; the bucket's velocity feeds the funnel's clone rate.
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
});

// ---------------------------------------------------------------------------
// watchlist — devnet sightings + manual watches. A mainnet fingerprint/authority
// match flags a program that "became real" (tested in the lab, now live).
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
// funnel_daily — one row per day: the 2000 → unique → novel counts and the
// category breakdown. Powers the Funnel surface (SPEC §6).
// ---------------------------------------------------------------------------
export const funnelDaily = pgTable(
  "funnel_daily",
  {
    date: text("date").notNull(), // YYYY-MM-DD (ET)
    network: text("network").default("mainnet").notNull(),
    raw: integer("raw").default(0).notNull(), // total deploy + upgrade events
    unique: integer("unique").default(0).notNull(), // unique bytecode (Y)
    novel: integer("novel").default(0).notNull(), // Z
    clones: integer("clones").default(0).notNull(),
    variants: integer("variants").default(0).notNull(),
    byCategory: jsonb("by_category").$type<Record<string, number>>().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // one row per (day, cluster): a devnet snapshot must not clobber mainnet's
  (t) => [primaryKey({ columns: [t.date, t.network] })],
);

// ---------------------------------------------------------------------------
// operator_log — every lever pull (naming, tuning, watching). Edits are part
// of the record.
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
// config — runtime-tunable thresholds, weights, windows. Single-row-per-key.
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
// program_references — the edge list: which programs a binary NAMES.
//
// A program id is a 32-byte constant, and a program that CPIs into another
// almost always carries the callee's id as one. references.ts recovers them by
// scanning the image against an index of the whole corpus; this is where the
// result lands.
//
// An edge is a claim about ONE image, so it carries the sha256 it was read
// from: an upgrade can add or drop references, and "klend named kvault" is only
// true of the build that did. Rows are replaced wholesale per program on each
// extraction rather than accumulated, so a dropped reference actually
// disappears instead of haunting the graph forever.
// ---------------------------------------------------------------------------
export const programReferences = pgTable(
  "program_references",
  {
    id: text("id").primaryKey(), // ref_<ulid>
    network: text("network").notNull(),
    fromProgramId: text("from_program_id").notNull(),
    toProgramId: text("to_program_id").notNull(),
    /** the image the edge was read from — an upgrade can change the set */
    fromSha256: text("from_sha256"),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("prog_ref_edge_idx").on(t.network, t.fromProgramId, t.toProgramId),
    index("prog_ref_from_idx").on(t.network, t.fromProgramId),
    // the reverse question — "who names THIS program" — is the more interesting
    // one on a dossier, and it has no other index to ride on
    index("prog_ref_to_idx").on(t.network, t.toProgramId),
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
    // programId → the name THAT program should carry, when the entity name is
    // too coarse. Jupiter owns a dozen programs; calling all of them "Jupiter"
    // is accurate and useless. Ids absent from this map fall back to the
    // entity name, which is right for a single-program protocol.
    programNames: jsonb("program_names").$type<Record<string, string>>().default({}).notNull(),
    authorities: jsonb("authorities").$type<string[]>().default([]).notNull(),
    tvl: doublePrecision("tvl"),
    tvlUpdatedAt: timestamp("tvl_updated_at", { withTimezone: true }),
    source: text("source").default("labels").notNull(), // 'labels' | 'defillama' | 'operator'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("entities_slug_uq").on(t.slug)],
);

// ---------------------------------------------------------------------------
// saved_lists — a personal shortlist, without accounts.
//
// Saves used to live only in localStorage, so clearing browsing data wiped
// them with nothing to restore from. This is the smallest thing that survives
// that: the browser mints a random key, the list syncs here under it, and the
// key doubles as a bookmarkable URL. Whoever holds the link holds the list —
// a capability, not an identity. There is no login, no email, no recovery,
// and nothing personal in the row: it is a set of public program addresses.
// ---------------------------------------------------------------------------
export const savedLists = pgTable("saved_lists", {
  /** the capability key — unguessable, minted client-side */
  id: text("id").primaryKey(),
  /** program ids, newest first; capped on write */
  programIds: jsonb("program_ids").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
