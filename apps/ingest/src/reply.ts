import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema, readUsage, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// The reply — the card, and nothing else.
//
// There is no sentence to write. The card (card.ts) says what the program is,
// how much compute its transactions burn, what it trusts and what trusts it,
// and how busy it has been; it letters the dossier URL along its own footer.
// Any text beside it repeated the picture or editorialised over it, and every
// phrasing we tried did one or the other.
//
// Two things follow from posting no text. A post carrying a link costs $0.20
// against $0.015 for one that does not, and X has downranked outbound links
// for years — so this is thirteen times cheaper AND travels further. And the
// old worry about a model writing in Ash's voice is gone by construction:
// there is no prose in the path at all.
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
  _opts: { limit?: number } = {},
): Promise<ReplyDraft | null> {
  const [row] = await db
    .select({ id: schema.subjects.id, network: schema.subjects.network, name: schema.subjects.name })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.kind, "program")));
  if (!row) return null;

  // `text` is what gets POSTED, and nothing does. `considered` is what the
  // review queue shows a human so they know which program they are approving —
  // it never reaches X.
  return {
    programId,
    network: row.network as Network,
    text: "",
    considered: [sanitizeDeclared(row.name) ?? "unnamed program", programId],
  };
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
