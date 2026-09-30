import type { SecurityTxt } from "./types.js";

// ---------------------------------------------------------------------------
// The PMP "security" account, read as a security.txt.
//
// Anchor ≥1.0 and the program-metadata CLI publish security contacts in a
// canonical Program Metadata account (seed "security") instead of compiling a
// block into the binary. Same purpose, different home — so everywhere On
// Record reports a security.txt, this counts as one too (metadata.ts fetches
// it; facts.pmpSecurity keeps the raw JSON).
//
// The embedded block is a fixed key/value stream the Neodyme macro enforces.
// The PMP payload is free JSON that nothing validates, and the corpus shows it
// (66 stored records, 2026-09-30): contacts arrive as a comma string, an array
// of `type:value` strings, or an array of objects; keys come as `contact`,
// `expires`, `acknowledgments`, `preferred-languages`, `sourceUrl`. This folds
// all of that onto the Neodyme field set so one renderer reads both, and keeps
// everything else the developer wrote as `extra` rather than dropping it.
//
// Every value is attacker-controlled text. Nothing here turns one into a link;
// the renderers do that, behind their own http(s) checks.
// ---------------------------------------------------------------------------

/** The Neodyme field names, in the order the standard lists them. */
const FIELDS = [
  "name",
  "project_url",
  "contacts",
  "policy",
  "preferred_languages",
  "encryption",
  "source_code",
  "source_release",
  "source_revision",
  "auditors",
  "acknowledgements",
  "expiry",
] as const satisfies readonly (keyof SecurityTxt)[];

/** Other spellings seen in PMP payloads, after snake-casing. */
const ALIASES: Record<string, keyof SecurityTxt> = {
  contact: "contacts",
  expires: "expiry",
  acknowledgments: "acknowledgements",
  source_url: "source_code",
  home_url: "project_url",
  audit_urls: "auditors",
};

/** Contact channels the security.txt convention names (`type:value`). */
const CHANNELS = ["email", "link", "discord", "telegram", "twitter", "x", "other"];

export interface PmpSecurityTxt {
  /** the security.txt fields, spelled and shaped the Neodyme way */
  fields: SecurityTxt;
  /** everything else the account holds — description, version, logo, vendor
   *  `x_…` blocks — flattened to text, in the order the developer wrote it */
  extra: { key: string; value: string }[];
  /** holds a contact or a disclosure policy. That is what makes it a
   *  security.txt; an account with only a name and a description is a label,
   *  and is shown but not counted. */
  counts: boolean;
}

const snake = (k: string): string =>
  k
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** One contact entry → `type:value`. Objects come as {type, contact} or as
 *  {email, twitter, …} cards; a card's display name is not a channel. */
function contactEntries(v: unknown): string[] {
  const s = scalar(v);
  if (s) return [s];
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const type = scalar(o.type);
  const value = scalar(o.contact) ?? scalar(o.value);
  if (type && value) return [`${type}:${value}`];
  const out: string[] = [];
  for (const [k, raw] of Object.entries(o)) {
    const val = scalar(raw);
    if (!val || k === "name" || k === "type") continue;
    out.push(`${CHANNELS.includes(k.toLowerCase()) ? k.toLowerCase() : "other"}:${val}`);
  }
  return out;
}

function fieldValue(key: keyof SecurityTxt, v: unknown): string | null {
  if (key === "contacts") {
    const list = (Array.isArray(v) ? v : [v]).flatMap(contactEntries);
    return list.length ? list.join(",") : null;
  }
  if (Array.isArray(v)) {
    const list = v.map(scalar).filter((x): x is string => Boolean(x));
    return list.length ? list.join(key === "preferred_languages" ? ", " : ",") : null;
  }
  return scalar(v);
}

/** Flatten a non-field value to leaf rows: arrays of scalars join, objects
 *  descend with a dotted key. Depth-capped — this is someone else's JSON. */
function flatten(key: string, v: unknown, out: PmpSecurityTxt["extra"], depth = 0): void {
  const s = scalar(v);
  if (s) {
    out.push({ key, value: s });
    return;
  }
  if (Array.isArray(v)) {
    const list = v.map(scalar).filter((x): x is string => Boolean(x));
    if (list.length === v.length) {
      if (list.length) out.push({ key, value: list.join(", ") });
      return;
    }
    if (depth < 2) v.forEach((item, i) => flatten(`${key}.${i}`, item, out, depth + 1));
    return;
  }
  if (v && typeof v === "object" && depth < 2) {
    for (const [k, inner] of Object.entries(v)) flatten(`${key}.${k}`, inner, out, depth + 1);
  }
}

const MAX_EXTRA = 24;

/** Read a raw PMP security payload (facts.pmpSecurity) as a security.txt.
 *  Null when it is not a JSON object or holds nothing readable. */
export function readPmpSecurity(raw: unknown): PmpSecurityTxt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields: SecurityTxt = {};
  const extra: PmpSecurityTxt["extra"] = [];
  for (const [rawKey, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = snake(rawKey);
    const field = (FIELDS as readonly string[]).includes(k)
      ? (k as keyof SecurityTxt)
      : ALIASES[k];
    // first spelling wins: a payload carrying both `contacts` and `contact`
    // keeps the standard one and shows the other as written
    if (field && fields[field] === undefined) {
      const value = fieldValue(field, v);
      if (value) fields[field] = value;
      continue;
    }
    flatten(rawKey, v, extra);
  }
  const ordered: SecurityTxt = {};
  for (const f of FIELDS) if (fields[f]) ordered[f] = fields[f];
  if (!Object.keys(ordered).length && !extra.length) return null;
  return {
    fields: ordered,
    extra: extra.slice(0, MAX_EXTRA),
    counts: Boolean(ordered.contacts || ordered.policy),
  };
}

/** Where a program's security.txt was found. */
export type SecurityTxtSource = "binary" | "pmp" | "both";

/** The one rule for "has a security.txt": embedded in the binary, or a PMP
 *  security account that carries a contact or a policy. */
export function securityTxtSource(facts: {
  hasSecurityTxt?: boolean;
  securityTxt?: unknown;
  pmpSecurity?: unknown;
}): SecurityTxtSource | null {
  const binary = Boolean(facts.hasSecurityTxt || facts.securityTxt);
  const pmp = Boolean(readPmpSecurity(facts.pmpSecurity)?.counts);
  return binary && pmp ? "both" : binary ? "binary" : pmp ? "pmp" : null;
}
