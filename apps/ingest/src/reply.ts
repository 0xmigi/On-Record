import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema, readUsage, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// The reply — one program in a post's worth of characters.
//
// The dossier is written for a reader who has to defend every sentence
// afterwards; this is written for someone who asked a question in public and
// gets one answer in their timeline. Same rule about provenance, a fiftieth of
// the room: every line here is a stored fact, and anything measured carries
// when it was measured.
//
// Three constraints shape the whole file.
//
//   TEMPLATE ONLY. No model writes any part of this. Half the input — a
//   program's declared name, its IDL, its security.txt — is authored by the
//   deployer, who is exactly the person with a reason to manipulate what an
//   automated account says about their program. A template cannot be argued
//   with; a prompt can. The declared name that does get through is scrubbed
//   (`declared`) so it can't carry a mention, a link, or a line break out into
//   a post published under Ash's name.
//
//   FREE. Reads stored rows only — no RPC, no Helius, no bytecode. A reply
//   costs a database query, so a busy day costs nothing and nobody can turn
//   the bot into a spending faucet by mentioning it repeatedly.
//
//   SILENT WHERE IT DOESN'T KNOW. A missing sample is a missing line, never a
//   zero. "Not sampled" and "no traffic" are different facts and the reply
//   would rather be short than blur them.
//
// Explicitly NOT said: txns24h. It has been wrong twice (a timer repeating one
// identical transaction; a deployer's own loader closes), and a bot repeating
// it to strangers is the fastest way to put a wrong number in public.
// ---------------------------------------------------------------------------

const WEB = process.env.PUBLIC_WEB_URL ?? "https://on-record.azuolas.xyz";

/** X's limit for an unverified account. Ash's may be higher; the reply is
 *  built to fit the smaller one so it reads the same everywhere. */
const LIMIT = Number(process.env.REPLY_MAX_CHARS ?? 280);

export interface ReplyDraft {
  programId: string;
  network: Network;
  /** ready to post, within the character limit */
  text: string;
  /** every line the composer considered, in priority order, before the
   *  character budget cut it — the review queue shows what was dropped */
  considered: string[];
}

/**
 * Strip a deployer-authored string down to something safe to publish.
 *
 * The name on a program is whatever its author put in its metadata. A program
 * called `@someone look at this 🔥 airdrop.xyz` would otherwise make an
 * automated account tag a stranger and link a site, in Ash's voice. So: no
 * mentions, no links, no line breaks, no control characters, and short.
 */
export function sanitizeDeclared(raw: string | null): string | null {
  if (!raw) return null;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // control chars, newlines included
    .replace(/https?:\/\/\S+/gi, "") // links
    .replace(/\b[\w.-]+\.(com|xyz|io|net|org|fun|app|co|gg)\b/gi, "") // bare domains
    .replace(/[@#$]/g, "") // mentions, hashtags, cashtags
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

const KB = 1024;
const MB = KB * KB;
const fmtSize = (n: number | null): string | null =>
  n === null ? null : n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= KB ? `${Math.round(n / KB)} KB` : `${n} B`;

function ago(d: Date | null): string | null {
  if (!d) return null;
  const h = (Date.now() - d.getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Past a season, a day count stops being readable — "deployed 1254d ago" is
 *  arithmetic homework. Old programs get the month they landed. */
function when(d: Date | null): string | null {
  if (!d) return null;
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days <= 90) return ago(d);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** How the upgrade authority reads in four words or fewer. */
function control(row: { authorityClass: string | null; facts: Record<string, unknown> }): string | null {
  const multisig = (row.facts as { multisig?: { threshold?: number; members?: number } }).multisig;
  switch (row.authorityClass) {
    case "none":
      return "immutable";
    case "squads":
      return multisig?.threshold && multisig?.members
        ? `${multisig.threshold}-of-${multisig.members} multisig`
        : "squads multisig";
    case "program":
      return "authority is a program";
    case "hot_wallet":
      return "authority is a hot wallet";
    default:
      return null;
  }
}

/**
 * One program, as a reply.
 *
 * Lines are built in priority order and the budget cuts from the bottom, so a
 * program with a lot to say loses its least important line rather than being
 * truncated mid-fact. The link is reserved out of the budget up front — a reply
 * that doesn't link back is worse than one that says less.
 */
export async function composeReply(
  programId: string,
  opts: { limit?: number } = {},
): Promise<ReplyDraft | null> {
  const limit = opts.limit ?? LIMIT;
  const [row] = await db
    .select()
    .from(schema.subjects)
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.kind, "program")));
  if (!row) return null;

  const network = row.network as Network;
  const facts = (row.facts ?? {}) as Record<string, unknown>;
  const profile = row.profile as { framework?: string } | null;
  const lines: string[] = [];

  // 1. what it is. The declared name is the deployer's claim, so it is quoted
  //    and scrubbed; everything after it is read off the binary.
  const name = sanitizeDeclared(row.name);
  const identity = [
    name ? `"${name}"` : "unnamed",
    profile?.framework && profile.framework !== "unknown" ? profile.framework : null,
    fmtSize(row.sizeBytes),
    // firstDeployAt is the program's ORIGINAL deploy, read from ProgramData
    // history; firstSeenAt is only when the radar started watching. Kamino
    // deployed in 2023 and landed on record 84 days ago — calling the second
    // one "deployed" would be a wrong fact in a public reply.
    row.firstDeployAt
      ? `deployed ${when(row.firstDeployAt)}`
      : when(row.firstSeenAt)
        ? `on record ${when(row.firstSeenAt)}`
        : null,
  ].filter(Boolean);
  lines.push(identity.join(" · "));

  // 2. where it sits against everything on record. The band alone is an
  //    adjective; the distance is the fact behind it.
  const nearest = facts.nearest as { distance?: number } | undefined;
  const [{ n: corpus } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        ne(schema.subjects.id, programId),
      ),
    );
  if (row.noveltyBand) {
    const against = `${Number(corpus).toLocaleString("en-US")} on record`;
    lines.push(
      nearest?.distance != null
        ? `${row.noveltyBand} — closest code of ${against} is ${nearest.distance} TLSH away`
        : `${row.noveltyBand} against ${against}`,
    );
  }

  // 3. who can change it, and whether the source is confirmed. Both are the
  //    questions somebody asking about an unknown program actually has.
  const trust = [
    control({ authorityClass: row.authorityClass, facts }),
    row.verified ? "verified build" : "build not verified",
  ].filter(Boolean);
  if (trust.length) lines.push(trust.join(" · "));

  // 4. what it is actually used for — from the stored parse, with its age.
  //    Silent when nobody has sampled it: a blank is honest, a zero is not.
  const usage = await readUsage(programId);
  const top = usage.value?.instructions?.[0];
  if (top && usage.value && usage.sampledAt) {
    lines.push(
      `top call: ${top.name}, ${top.pct.toFixed(0)}% of ${usage.value.window.txnsWithProgram} txns (${ago(usage.sampledAt)})`,
    );
  }

  const link = `${WEB}/p/${programId}`;
  const considered = [...lines];

  // budget: keep the link, then take lines from the top until they stop fitting
  const room = limit - link.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }

  return { programId, network, text: [...kept, link].join("\n"), considered };
}

// --- reading the question -----------------------------------------------

/** base58, and long enough that a word can't be mistaken for an address */
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const RECORD_LINK = /on-record\.azuolas\.xyz\/p\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi;

/**
 * The program ids a mention is asking about, in the order they appear.
 *
 * A link to the site wins over a bare address in the same post: if somebody
 * pastes a dossier link AND quotes an address out of the page, the link is the
 * thing they are pointing at. Capped, so one post cannot fan out into twenty
 * replies.
 */
export function programIdsIn(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RECORD_LINK)) if (!out.includes(m[1]!)) out.push(m[1]!);
  if (!out.length) {
    const stripped = text.replace(RECORD_LINK, " ").replace(/https?:\/\/\S+/g, " ");
    for (const m of stripped.matchAll(BASE58)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out.slice(0, max);
}
