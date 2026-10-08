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
    type: text("type").notNull(), // 'deploy' | 'upgrade' | 'set_authority' | 'close' | 'extend'
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

// ---------------------------------------------------------------------------
// activity_samples — the two metered reads, written down.
//
// Instruction usage (usage.ts) and traffic shape (traffic.ts) are the only
// facts this codebase used to re-derive on every read. Both cost Helius credits
// per call, and both were computed on a REQUEST path: every load of /p/<id> ran
// a live 400-transaction parse, and every dossier fetch sampled 200 more. The
// cost therefore scaled with strangers looking at the site rather than with
// programs being deployed — an unauthenticated GET worth ~400 credits, which is
// a drain as much as an expense.
//
// So: samples are taken by a background sweep and read from here. Request paths
// never sample. They record demand (`requestedAt`) and the sweep decides what to
// spend on, which caps the bill at the sweep's own budget no matter how much
// traffic arrives.
//
// Absent, zero and unknown stay distinct, as everywhere else here:
//   no row / null *SampledAt  →  never looked
//   *SampledAt set, payload null  →  looked, and there is genuinely nothing
//                                    (no IDL to decode against; no signatures)
// Anything rendering these MUST show `sampledAt`. A traffic figure with no
// measurement time is a claim that cannot be defended.
// ---------------------------------------------------------------------------
export const activitySamples = pgTable(
  "activity_samples",
  {
    /** the program id — one row per subject, holding only the latest sample */
    subjectId: text("subject_id").primaryKey(),
    network: text("network").notNull(),
    /** InstructionUsage | null — null means decoded against an IDL and found nothing */
    usage: jsonb("usage").$type<Record<string, unknown> | null>(),
    usageSampledAt: timestamp("usage_sampled_at", { withTimezone: true }),
    /** TrafficSample | null — null means the program id has no transaction history */
    traffic: jsonb("traffic").$type<Record<string, unknown> | null>(),
    trafficSampledAt: timestamp("traffic_sampled_at", { withTimezone: true }),
    /** last time a human asked for this program. Drives what the sweep refreshes:
     *  credits go to programs somebody actually looked at, not the whole corpus. */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // the sweep's pick order: wanted but never sampled first, then stalest.
    index("activity_samples_usage_stale_idx").on(t.network, t.usageSampledAt),
    index("activity_samples_traffic_stale_idx").on(t.network, t.trafficSampledAt),
    index("activity_samples_requested_idx").on(t.network, t.requestedAt),
  ],
);

// ---------------------------------------------------------------------------
// Bot replies — every mention the query bot has seen, and what it said back.
//
// One row per mention, including the ones it decided not to answer, because
// this table IS the cursor: the next sweep asks X for mentions newer than the
// highest id here. A mention that produced no reply must therefore still be
// recorded, or it would be re-read forever.
//
// It is also the audit trail. The bot posts in Ash's name, so "what did it say,
// to whom, from which program row, and when" has to survive the post itself —
// X can be edited or deleted; this cannot.
// ---------------------------------------------------------------------------
export const botReplies = pgTable(
  "bot_replies",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull().default("x"),
    /** the post that asked — unique, so one question gets at most one answer */
    mentionId: text("mention_id").notNull(),
    authorHandle: text("author_handle"),
    mentionText: text("mention_text"),
    /** null when the mention named no program we hold */
    programId: text("program_id"),
    network: text("network"),
    /** what the composer produced, verbatim */
    text: text("text"),
    /** 'pending' (composed, awaiting a human) | 'posted' | 'skipped' | 'failed' */
    status: text("status").notNull().default("pending"),
    postedId: text("posted_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("bot_replies_mention_idx").on(t.platform, t.mentionId),
    index("bot_replies_status_idx").on(t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// alert_subscriptions — verification alerts, signed up for by wallet.
//
// No accounts. A developer gives an address (an upgrade authority, or the
// Squads multisig behind one) and somewhere to be pinged. Every mainnet program
// that address controls is watched, including ones it deploys later, so there
// is no program list to keep up to date. `manageToken` is the capability that
// unsubscribes, like a saved list's key.
//
// A subscription is live once `confirmedAt` is set: a webhook confirms by
// accepting a test ping; email will confirm by link, so nobody can point
// alerts at someone else's inbox.
// ---------------------------------------------------------------------------
export const alertSubscriptions = pgTable(
  "alert_subscriptions",
  {
    id: text("id").primaryKey(),
    /** the wallet as entered: an upgrade authority or a Squads multisig */
    address: text("address").notNull(),
    /** 'webhook' | 'email' | 'telegram' */
    channel: text("channel").notNull(),
    /** a webhook URL, an email address or a Telegram chat id */
    target: text("target").notNull(),
    confirmToken: text("confirm_token"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    manageToken: text("manage_token").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("alert_subs_address_idx").on(t.address),
    uniqueIndex("alert_subs_manage_idx").on(t.manageToken),
  ],
);

// ---------------------------------------------------------------------------
// alert_deliveries — every verdict the alert sweep reached, sent or not.
//
// One row per (subscription, program, version, kind). The unique index is what
// makes the sweep safe to re-run: a version is judged once, and a ping is sent
// at most once. kind:
//   'unverified'  the version was still unverified after the grace window — pinged
//   'ok'          it was verified in time — recorded, nothing sent
//   'restored'    a pinged version became verified later — pinged
// ---------------------------------------------------------------------------
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id").notNull(),
    programId: text("program_id").notNull(),
    /** the deploy/upgrade slot the verdict is about */
    slot: bigint("slot", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    /** 'sent' | 'failed' | 'silent' */
    status: text("status").notNull(),
    /** the diagnosis the ping carried, verbatim */
    detail: text("detail"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("alert_deliveries_once_idx").on(t.subscriptionId, t.programId, t.slot, t.kind),
    index("alert_deliveries_program_idx").on(t.programId, t.slot),
  ],
);

// ---------------------------------------------------------------------------
// loader_txns — the raw loader record: one row per upgradeable-loader
// instruction that acted on a program's ProgramData, read back from that
// account's signature history (loader-history.ts). Research data for the
// deployer-behavior questions; nothing on the product reads it yet.
//
// Separate from `events` on purpose. `events` drives the timeline, the funnel
// and the pipeline, and labels every ProgramData signature an upgrade, including
// SetAuthority and the 12% of signatures that only reference the account
// (programs that check their own upgrade authority). Here every row is a
// decoded instruction with the signer, fee payer and authority before/after.
//
// Append-only and raw. Failed transactions are kept (failed = true) because a
// failed upgrade attempt is behaviour too; analysis filters them out.
// ---------------------------------------------------------------------------
export const loaderTxns = pgTable(
  "loader_txns",
  {
    network: text("network").notNull(),
    signature: text("signature").notNull(),
    programId: text("program_id").notNull(),
    /** position of the instruction: top-level index, and the index inside its
     *  inner-instruction group (-1 when it is top-level) */
    outerIndex: integer("outer_index").notNull(),
    innerIndex: integer("inner_index").notNull(),
    programDataAddress: text("program_data_address").notNull(),
    /** deploy | upgrade | set_authority | set_authority_checked | close |
     *  extend | extend_checked | migrate | unknown */
    kind: text("kind").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    failed: boolean("failed").notNull(),
    /** accountKeys[0] — who paid the fee */
    feePayer: text("fee_payer").notNull(),
    /** every signer of the transaction */
    signers: text("signers").array().notNull(),
    /** the upgrade authority this instruction was signed under */
    authorityBefore: text("authority_before"),
    /** the upgrade authority after it. Null after a set_authority means the
     *  program was made immutable; null after a close means it is gone. */
    authorityAfter: text("authority_after"),
    /** the account that paid rent (deploy, extend) */
    payer: text("payer"),
    buffer: text("buffer"),
    /** the program that invoked the loader by CPI (a Squads vault upgrade, a
     *  governance program), or null for a top-level instruction */
    invokedBy: text("invoked_by"),
    /** 'legacy' | '0' | '1' */
    txVersion: text("tx_version").notNull(),
    /** the instruction as the RPC parsed it, verbatim */
    info: jsonb("info").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "loader_txns_pk", columns: [t.signature, t.programId, t.outerIndex, t.innerIndex] }),
    index("loader_txns_program_idx").on(t.network, t.programId, t.slot),
    index("loader_txns_kind_idx").on(t.network, t.kind),
    index("loader_txns_fee_payer_idx").on(t.feePayer),
    index("loader_txns_authority_idx").on(t.authorityAfter),
    index("loader_txns_authority_before_idx").on(t.authorityBefore),
  ],
);

// ---------------------------------------------------------------------------
// loader_walks — what the loader record covers, one row per program walked.
// Every finding states its coverage ("measured on Y of Z"), and this is where
// Y comes from: a program missing here was never read, a truncated walk's
// first events are unknown rather than absent, and `nonLoader` counts the
// ProgramData signatures that carried no loader instruction for it.
// ---------------------------------------------------------------------------
export const loaderWalks = pgTable("loader_walks", {
  network: text("network").notNull(),
  programId: text("program_id").notNull(),
  programDataAddress: text("program_data_address").notNull(),
  /** 'complete' | 'partial' (some transactions unreadable) | 'truncated'
   *  (page cap hit, oldest history unread) | 'empty' | 'error' */
  status: text("status").notNull(),
  /** signatures on the ProgramData account we listed */
  signatures: integer("signatures").notNull(),
  /** of those, transactions with no loader instruction for this program */
  nonLoader: integer("non_loader").notNull(),
  /** getTransaction returned null or kept failing — not read */
  unread: integer("unread").notNull(),
  loaderRows: integer("loader_rows").notNull(),
  /** newest signature walked: the `until` for the next incremental read */
  newestSignature: text("newest_signature"),
  newestSlot: bigint("newest_slot", { mode: "number" }),
  oldestSlot: bigint("oldest_slot", { mode: "number" }),
  error: text("error"),
  walkedAt: timestamp("walked_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ name: "loader_walks_pk", columns: [t.network, t.programId] })]);

// ---------------------------------------------------------------------------
// Wallet profiles (/b/<address>). The loader record says what every wallet did
// to every program; these two say who it acts with.
// ---------------------------------------------------------------------------

/** Who sits on each Squads multisig that controls a program on record, as read
 *  from the multisig account. A whole multisig is re-read at once, so every row
 *  for it shares `readAt`. */
export const multisigMembers = pgTable(
  "multisig_members",
  {
    network: text("network").notNull(),
    multisig: text("multisig").notNull(),
    member: text("member").notNull(),
    /** 'v4' (v3's layout isn't decoded) */
    version: text("version").notNull(),
    threshold: integer("threshold"),
    memberCount: integer("member_count"),
    readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "multisig_members_pk", columns: [t.network, t.multisig, t.member] }),
    index("multisig_members_member_idx").on(t.network, t.member),
  ],
);

/** Where a wallet's first SOL came from: the account whose balance dropped most
 *  in its oldest transaction, when the wallet received SOL in it. `busy` marks
 *  a wallet with 1,000+ transactions (an exchange, bridge or service, most
 *  likely), which a trail is never followed past. */
export const fundingTrails = pgTable(
  "funding_trails",
  {
    network: text("network").notNull(),
    address: text("address").notNull(),
    funder: text("funder"),
    lamports: bigint("lamports", { mode: "number" }),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    busy: boolean("busy").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "funding_trails_pk", columns: [t.network, t.address] }),
    index("funding_trails_funder_idx").on(t.network, t.funder),
  ],
);
