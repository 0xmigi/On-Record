/**
 * Turning a version delta into a sentence — without an LLM.
 *
 * "+2 instructions · +1.7 KB" is a measurement, not a changelog. What a reader
 * wants is "can now place trigger orders". Every part of that is already in the
 * data; it just needs reading rather than counting:
 *
 *   integrations  a list of known program ids found embedded in the binary, so
 *                 a new entry IS "now talks to Orca Whirlpool"
 *   instructions  handler names are verb_object by near-universal convention
 *                 (initialize/set/update/create/claim/close/cancel/... account
 *                 for most of the corpus), so they map to verb phrases
 *   capabilities  syscall groups — cpi means it calls other programs
 *
 * All deterministic. Nothing is invented: if a name doesn't parse, it's printed
 * as-is rather than guessed at.
 */

// ── source-path hygiene ─────────────────────────────────────────────
// Rust's own library and common vendored crates compile their panic paths into
// the binary, so `src/fmt/`, `src/raw_vec/`, `src/ser/` show up on thousands of
// programs and belong to nobody's program. Counting them as "files changed"
// reports the compiler's source tree as the author's work.
const VENDOR_DIRS = new Set([
  "fmt", "unicode", "ser", "de", "str", "raw_vec", "iter", "collections", "num",
  "slice", "io", "raw", "sync", "alloc", "core", "std", "vec", "hash", "ops",
  "char", "ascii", "convert", "option", "result", "panicking", "backtrace",
  "macros", "internal", "imp", "sys", "sys_common", "thread", "time", "cmp",
]);

export function isProgramPath(path: string): boolean {
  // an explicit crate prefix means the author's own tree, always
  if (/^programs?\//i.test(path)) return true;
  const dir = path.match(/src\/([a-z0-9_-]+)\//i)?.[1]?.toLowerCase();
  if (!dir) return true; // bare src/foo.rs — no directory to judge, keep it
  return !VENDOR_DIRS.has(dir);
}

// ── instruction names → verb phrases ────────────────────────────────
// Leading token → how it reads in a sentence. Anything not listed falls back to
// the token itself, which is already a verb often enough to be safe.
const VERBS: Record<string, string> = {
  initialize: "set up", init: "set up", create: "create", open: "open",
  close: "close", cancel: "cancel", place: "place", claim: "claim",
  withdraw: "withdraw", deposit: "deposit", settle: "settle", set: "set",
  update: "update", delegate: "delegate", undelegate: "undelegate",
  migrate: "migrate", collect: "collect", buy: "buy", sell: "sell",
  mint: "mint", burn: "burn", transfer: "transfer", liquidate: "liquidate",
  fund: "fund", register: "register", revoke: "revoke", grant: "grant",
  remove: "remove", add: "add", execute: "run", crank: "crank",
  sync: "sync", refresh: "refresh", commit: "commit", finalize: "finalize",
  accept: "accept", request: "request", join: "join", stake: "stake",
  unstake: "unstake", swap: "swap", repay: "repay", borrow: "borrow",
  modify: "modify", prepare: "prepare", process: "process", publish: "publish",
  activate: "activate", pause: "pause", resume: "resume", freeze: "freeze",
};

// snake_case and PascalCase both occur — normalise to lowercase tokens
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean);
}

// Words that must not be pluralised, or the phrase reads as nonsense:
// `cancel_up_to` → "cancel up tos", `set_book_private` → "set book privates".
const PARTICLES = new Set([
  "to", "up", "for", "in", "of", "by", "out", "off", "on", "into", "from",
  "with", "all", "any", "and", "or", "as", "at",
]);
const ADJECTIVES = new Set([
  "private", "public", "dark", "active", "inactive", "open", "closed", "new",
  "old", "max", "min", "raw", "live", "full", "partial", "internal", "external",
]);

function plural(word: string): string {
  // already plural — `collect_fees` must not become "collect feeses"
  if (/s$/.test(word)) return word;
  // participles and adjectives aren't countable: `liquidate_isolated`
  if (/ed$/.test(word)) return word;
  if (PARTICLES.has(word) || ADJECTIVES.has(word)) return word;
  // acronyms (adl, twap) read worse pluralised
  if (word.length <= 3 && !/[aeiou]{1,}/.test(word.slice(1))) return word;
  if (/(x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** `place_trigger_order` → "place trigger orders" */
export function phrase(instruction: string): string {
  const t = tokens(instruction);
  if (!t.length) return instruction;
  const verb = VERBS[t[0]] ?? t[0];
  const rest = t.slice(1);
  if (!rest.length) return verb;
  // pluralise the object so it reads as a capability, not one call
  const obj = [...rest.slice(0, -1), plural(rest[rest.length - 1])].join(" ");
  return `${verb} ${obj}`;
}

// ── capabilities → plain english ────────────────────────────────────
const CAPS: Record<string, string> = {
  cpi: "started calling other programs",
  pda: "started deriving program addresses",
  hashing: "started hashing on-chain",
  "advanced-crypto": "added signature verification",
  "return-data": "started returning data to callers",
  sysvars: "started reading chain state",
};

export type Delta = {
  instructions?: { added: string[]; removed: string[]; removedHidden?: number };
  sourcePaths?: { added: string[]; removed: string[] };
  integrations?: { added: string[]; removed: string[] };
  capabilities?: { added: string[]; removed: string[] };
};

export type Statement = { text: string; tone: "add" | "remove" | "neutral" };

/** joins with commas and a trailing "and", capping the list */
function list(items: string[], max: number): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  let s: string;
  if (shown.length === 1) s = shown[0];
  else s = `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${s}, and ${rest} more` : s;
}

/**
 * The headline statements for one version, most meaningful first.
 *
 * Ordering is the whole point: an integration is a fact about what the program
 * now touches, which beats a handler rename. Byte counts don't appear at all —
 * they're a measurement of the build, not a description of the change.
 */
export function describe(d: Delta, opts: { max?: number } = {}): Statement[] {
  const max = opts.max ?? 3;
  const out: Statement[] = [];

  // 1. integrations — the strongest signal, and already plain english
  if (d.integrations?.added.length)
    out.push({ text: `Now talks to ${list(d.integrations.added, 3)}`, tone: "add" });
  if (d.integrations?.removed.length)
    out.push({ text: `No longer touches ${list(d.integrations.removed, 3)}`, tone: "remove" });

  // 2. what it can do now / can no longer do
  if (d.instructions?.added.length)
    out.push({ text: `Can now ${list(d.instructions.added.map(phrase), 3)}`, tone: "add" });
  if (d.instructions?.removed.length)
    out.push({ text: `Dropped the ability to ${list(d.instructions.removed.map(phrase), 3)}`, tone: "remove" });

  // 3. capabilities — only the gain reads as news
  for (const c of d.capabilities?.added ?? []) {
    if (CAPS[c]) out.push({ text: capitalise(CAPS[c]), tone: "add" });
  }

  // 4. author's own new source files, only when nothing better was found
  if (!out.length) {
    const added = (d.sourcePaths?.added ?? []).filter(isProgramPath);
    if (added.length) {
      const names = added.map((p) => p.split("/").pop()!.replace(/\.rs$/, "").replace(/_/g, " "));
      out.push({ text: `New code for ${list(names, 3)}`, tone: "add" });
    }
  }

  return out.slice(0, max);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
