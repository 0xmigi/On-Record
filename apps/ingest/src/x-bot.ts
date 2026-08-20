import crypto from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, logger, newId } from "@onrecord/core";
import { composeReply, programIdsIn } from "./reply.js";

// ---------------------------------------------------------------------------
// The query bot — answers a mention on X with what the record holds.
//
// Somebody posts an address at the account; it replies with the program in one
// post and a link to the dossier. That is the whole product. The interesting
// part is everything it refuses to do.
//
//   IT NEVER POSTS ANYTHING A MODEL WROTE. The reply comes out of a template
//   over stored columns (reply.ts). A program's own metadata is attacker-chosen
//   text, and @onrecorddot speaks for the record Ash publishes under — an LLM
//   in that path is a stranger with posting rights to it.
//
//   IT COSTS NOTHING TO ASK, AND IT IS CAPPED WHEN IT ANSWERS. Composing reads
//   the database, never the chain, so Helius cannot be moved by strangers. X
//   itself is now pay-per-use ($0.015 a post, $0.20 when the post carries a
//   link — and every reply carries the dossier link), so the answering side has
//   a hard daily ceiling. A mention cannot cost more than the cap, whoever is
//   sending them. The sample sweep is the lesson: an unbounded job pointed at
//   strangers is a bill with no upper limit.
//
//   IT DOES NOT POST UNTIL TOLD TO. Three modes: `off`, `draft` (compose,
//   store, wait for a human to approve), `live` (post immediately). Draft is
//   the default, and the mode is the only thing standing between a bad reply
//   and Ash's followers — so it is one explicit env var, not a heuristic.
//
// Every mention is written down, answered or not: the table is also the cursor
// (see schema), and an unrecorded mention would be re-read forever.
// ---------------------------------------------------------------------------

export type BotMode = "off" | "draft" | "live";

const API = "https://api.x.com/2";

const cfg = () => ({
  mode: (process.env.X_BOT_MODE ?? "draft") as BotMode,
  /** the account whose mentions are read — its numeric id, not the handle */
  userId: process.env.X_USER_ID ?? "",
  /** app-only bearer, for reading mentions */
  bearer: process.env.X_BEARER_TOKEN ?? "",
  /** OAuth 1.0a user context, for posting. Posting cannot use the bearer. */
  apiKey: process.env.X_API_KEY ?? "",
  apiSecret: process.env.X_API_SECRET ?? "",
  accessToken: process.env.X_ACCESS_TOKEN ?? "",
  accessSecret: process.env.X_ACCESS_SECRET ?? "",
  /** how many mentions one sweep will answer, whatever arrives */
  maxPerSweep: Number(process.env.X_BOT_MAX_PER_SWEEP ?? 10),
  /** a question older than this gets read and recorded, never answered */
  maxAgeHours: Number(process.env.X_BOT_MAX_AGE_HOURS ?? 24),
  /** replies to one account per rolling day — the brake on a bot-to-bot loop */
  maxPerAuthorDay: Number(process.env.X_BOT_MAX_PER_AUTHOR_DAY ?? 3),
  /** posts per rolling day, all authors — the brake on the X bill. At $0.20 a
   *  linked post the default ceiling is $5/day however busy the mentions get. */
  maxPostsPerDay: Number(process.env.X_BOT_MAX_POSTS_PER_DAY ?? 25),
});

// --- X API ---------------------------------------------------------------

interface Mention {
  id: string;
  text: string;
  authorId?: string;
  authorHandle?: string;
  createdAt?: string;
}

/** Newest mentions first, everything after `sinceId`. */
async function fetchMentions(sinceId: string | null): Promise<Mention[]> {
  const c = cfg();
  const url = new URL(`${API}/users/${c.userId}/mentions`);
  url.searchParams.set("max_results", "25");
  url.searchParams.set("tweet.fields", "author_id,created_at");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  if (sinceId) url.searchParams.set("since_id", sinceId);

  const res = await fetch(url, { headers: { authorization: `Bearer ${c.bearer}` } });
  if (!res.ok) throw new Error(`x mentions: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { id: string; text: string; author_id?: string; created_at?: string }[];
    includes?: { users?: { id: string; username: string }[] };
  };
  const handles = new Map((body.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (body.data ?? []).map((t) => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id,
    authorHandle: t.author_id ? handles.get(t.author_id) : undefined,
    createdAt: t.created_at,
  }));
}

/** OAuth 1.0a signature — posting is a user-context action and the app-only
 *  bearer cannot do it. Standard HMAC-SHA1 over the normalised request.
 *  Exported so the credentials can be proved against a harmless user-context
 *  GET; the alternative is finding out whether signing works by posting. */
export function oauthHeader(method: string, url: string): string {
  const c = cfg();
  const params: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const enc = (v: string) =>
    encodeURIComponent(v).replace(/[!*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const base = [
    method.toUpperCase(),
    enc(url),
    enc(
      Object.keys(params)
        .sort()
        .map((k) => `${enc(k)}=${enc(params[k]!)}`)
        .join("&"),
    ),
  ].join("&");
  const key = `${enc(c.apiSecret)}&${enc(c.accessSecret)}`;
  const signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  const all = { ...params, oauth_signature: signature };
  return `OAuth ${Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}="${enc(all[k as keyof typeof all]!)}"`)
    .join(", ")}`;
}

/** Post one reply. Returns the new post's id. */
async function postReply(text: string, inReplyTo: string): Promise<string> {
  const url = `${API}/tweets`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyTo } }),
  });
  if (!res.ok) throw new Error(`x post: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: { id?: string } };
  if (!body.data?.id) throw new Error("x post: no id in response");
  return body.data.id;
}

// --- the loop ------------------------------------------------------------

let warnedNoCreds = false;

/** The cursor IS the table: the highest mention id already written down.
 *  Ids are snowflakes — numerically ordered — so max() is "newest seen". */
async function lastMentionId(): Promise<string | null> {
  const [row] = await db
    .select({ id: sql<string>`max(${schema.botReplies.mentionId}::numeric)::text` })
    .from(schema.botReplies)
    .where(eq(schema.botReplies.platform, "x"));
  return row?.id ?? null;
}

/**
 * Turn one mention into a row.
 *
 * Exported because it is the whole decision, and testing it should not require
 * an X account: hand it a string and it tells you what the bot would say.
 */
export async function draftFor(mention: Mention): Promise<{
  status: "pending" | "skipped";
  programId: string | null;
  text: string | null;
  network: string | null;
}> {
  const [programId] = programIdsIn(mention.text, 1);
  if (!programId) return { status: "skipped", programId: null, text: null, network: null };
  const draft = await composeReply(programId);
  // an address we hold nothing for is a question we cannot answer. Saying so
  // in public would be noise; the record is silent about it instead.
  if (!draft) return { status: "skipped", programId, text: null, network: null };
  return { status: "pending", programId, text: draft.text, network: draft.network };
}

/** One pass over new mentions. Safe to call on a timer; never runs twice at
 *  once (the cron's own overlap guard) and never re-answers a mention. */
export async function sweepMentions(): Promise<{ seen: number; drafted: number; posted: number }> {
  const c = cfg();
  if (c.mode === "off") return { seen: 0, drafted: 0, posted: 0 };
  if (!c.userId || !c.bearer) {
    // said once, not every five minutes: an unconfigured bot is the normal
    // state until Ash adds keys, and a warning per tick would bury the log
    if (!warnedNoCreds) {
      logger.warn("x bot: X_USER_ID / X_BEARER_TOKEN unset — sweeps are no-ops");
      warnedNoCreds = true;
    }
    return { seen: 0, drafted: 0, posted: 0 };
  }

  const mentions = (await fetchMentions(await lastMentionId())).reverse(); // oldest first
  let drafted = 0;
  let posted = 0;

  // COLD START. With an empty table there is no cursor, so X hands back the
  // last 25 mentions — which in `live` mode is 25 replies to conversations that
  // finished days ago, all at once, the first minute the keys are added. The
  // first sweep therefore reads the backlog, writes it down, and answers none
  // of it. From the second sweep on there is a cursor and only new questions
  // arrive.
  const coldStart = (await lastMentionId()) === null;
  if (coldStart && mentions.length) {
    for (const m of mentions) {
      await record(m, { status: "skipped", programId: null, text: null, network: null });
    }
    logger.info({ seen: mentions.length }, "x bot: cold start — backlog recorded, not answered");
    return { seen: mentions.length, drafted: 0, posted: 0 };
  }

  for (const m of mentions.slice(0, c.maxPerSweep)) {
    // never answer ourselves — a reply to our own reply is a loop with a
    // character limit
    if (m.authorId && m.authorId === c.userId) {
      await record(m, { status: "skipped", programId: null, text: null, network: null });
      continue;
    }
    // a stale question is not worth an unprompted reply days later
    const ageHours = m.createdAt ? (Date.now() - Date.parse(m.createdAt)) / 3_600_000 : 0;
    if (ageHours > c.maxAgeHours) {
      await record(m, { status: "skipped", programId: null, text: null, network: null });
      continue;
    }
    // and one account cannot pull more than a few answers a day out of it.
    // Two automated accounts that each answer every mention will talk to each
    // other until someone notices; this is the thing that stops that.
    if (m.authorHandle && (await repliesToAuthorToday(m.authorHandle)) >= c.maxPerAuthorDay) {
      await record(m, { status: "skipped", programId: null, text: null, network: null });
      logger.info({ author: m.authorHandle }, "x bot: author at daily reply cap");
      continue;
    }
    let outcome;
    try {
      outcome = await draftFor(m);
    } catch (err) {
      logger.warn({ mention: m.id, err: String(err) }, "x bot: draft failed");
      continue; // no row written: a transient DB error must not consume the mention
    }
    const row = await record(m, outcome);
    if (outcome.status !== "pending") continue;
    drafted++;

    if (c.mode === "live" && outcome.text) {
      if (await atDailyPostCap(c.maxPostsPerDay)) {
        // the draft stays pending, so a capped day is a queue to read rather
        // than an answer nobody got
        logger.warn({ cap: c.maxPostsPerDay }, "x bot: daily post cap reached, holding drafts");
        continue;
      }
      try {
        const id = await postReply(outcome.text, m.id);
        await db
          .update(schema.botReplies)
          .set({ status: "posted", postedId: id, postedAt: new Date() })
          .where(eq(schema.botReplies.id, row));
        posted++;
      } catch (err) {
        await db
          .update(schema.botReplies)
          .set({ status: "failed", error: String(err) })
          .where(eq(schema.botReplies.id, row));
        logger.error({ mention: m.id, err: String(err) }, "x bot: post failed");
      }
    }
  }

  if (mentions.length) logger.info({ seen: mentions.length, drafted, posted, mode: c.mode }, "x bot: sweep");
  return { seen: mentions.length, drafted, posted };
}

/** Posts made in the last 24h, across everyone — the spend ceiling. */
async function atDailyPostCap(cap: number): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.botReplies)
    .where(
      and(
        eq(schema.botReplies.status, "posted"),
        gte(schema.botReplies.postedAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  return Number(row?.n ?? 0) >= cap;
}

/** How many answers this account has already had out of the bot today. */
async function repliesToAuthorToday(handle: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.botReplies)
    .where(
      and(
        eq(schema.botReplies.authorHandle, handle),
        eq(schema.botReplies.status, "posted"),
        gte(schema.botReplies.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  return Number(row?.n ?? 0);
}

async function record(
  m: Mention,
  outcome: { status: string; programId: string | null; text: string | null; network: string | null },
): Promise<string> {
  const id = newId("bot");
  await db
    .insert(schema.botReplies)
    .values({
      id,
      platform: "x",
      mentionId: m.id,
      authorHandle: m.authorHandle ?? null,
      mentionText: m.text.slice(0, 500),
      programId: outcome.programId,
      network: outcome.network,
      text: outcome.text,
      status: outcome.status,
    })
    .onConflictDoNothing({ target: [schema.botReplies.platform, schema.botReplies.mentionId] });
  const [row] = await db
    .select({ id: schema.botReplies.id })
    .from(schema.botReplies)
    .where(and(eq(schema.botReplies.platform, "x"), eq(schema.botReplies.mentionId, m.id)));
  return row?.id ?? id;
}

/** Post a draft a human approved. The `draft` mode's other half. */
export async function approveReply(rowId: string): Promise<{ postedId: string }> {
  const [row] = await db.select().from(schema.botReplies).where(eq(schema.botReplies.id, rowId));
  if (!row) throw new Error("unknown reply");
  if (row.status === "posted") throw new Error("already posted");
  if (!row.text) throw new Error("nothing to post");
  const postedId = await postReply(row.text, row.mentionId);
  await db
    .update(schema.botReplies)
    .set({ status: "posted", postedId, postedAt: new Date() })
    .where(eq(schema.botReplies.id, rowId));
  return { postedId };
}

/** The review queue, newest first. */
export async function pendingReplies(limit = 25) {
  return db
    .select()
    .from(schema.botReplies)
    .where(eq(schema.botReplies.status, "pending"))
    .orderBy(desc(schema.botReplies.createdAt))
    .limit(limit);
}
