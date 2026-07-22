// ---------------------------------------------------------------------------
// The search corpus: one flat text blob per subject, matched with trigram
// ILIKE (not tsvector). Deliberate — the strings we recover from SBF bytecode
// have no word boundaries. The extractor grabs runs of printable bytes, so
// adjacent string literals arrive fused:
//
//   "from_bytesfrom_bytes_mutpumpfun-ladderactive-pool-positionopen-program-…"
//
// A tsvector would tokenize that into one useless 200-char lexeme. Substring
// matching finds "pumpfun-ladder" inside it. That is the whole reason a name
// like "tapedrive" is findable at all when the developer published nothing.
// ---------------------------------------------------------------------------

import type { SecurityTxt } from "./types.js";

/** Everything that can contribute searchable text for one program. */
export interface SearchTextParts {
  name?: string | null;
  repoUrl?: string | null;
  website?: string | null;
  social?: string | null;
  securityTxt?: SecurityTxt | null;
  category?: string | null;
  framework?: string | null;
  integrations?: string[] | null;
  capabilities?: string[] | null;
  idlInstructions?: string[] | null;
  /** raw printable strings recovered from the bytecode (fingerprint.strings) */
  strings?: string[] | null;
}

/** Total corpus cap per subject. At ~100 strings/program the raw blob runs
 *  1–15 KB; boilerplate stripping takes most rows well under this. The cap is
 *  what keeps the column linear as the index grows past a few hundred rows. */
const MAX_TEXT = 8_000;

/** ELF section names — present in literally every program, zero signal. */
const ELF_SECTIONS = new Set([
  ".text", ".rodata", ".data", ".bss", ".dynamic", ".dynsym", ".dynstr",
  ".rel.dyn", ".shstrtab", ".strtab", ".symtab", ".comment", ".gnu.hash",
  ".eh_frame", ".data.rel.ro", ".hash", ".note.GNU-stack",
]);

/** Toolchain paths that leak from the Rust stdlib, not the developer's crate.
 *  `programs/<name>/src/lib.rs` must survive this — that's the name signal. */
const TOOLCHAIN_PATH =
  /(?:\/rustc\/|platform-tools|library\/(?:alloc|core|std)\/|cargo\/registry|\/Users\/runner\/work)/i;

/** Panic/format boilerplate the Rust compiler emits into every binary. Excised
 *  as substrings rather than dropping whole strings, because the extractor
 *  fuses boilerplate onto real literals in the same run of printable bytes. */
const BOILERPLATE: RegExp[] = [
  /called `(?:Result|Option)::unwrap\(\)` on an? `(?:Err|None)` value/g,
  /assertion failed: [\w.:'"\[\]() >=<+*/-]{0,48}/g,
  /index out of bounds: the len is|but the index is/g,
  /attempt to (?:divide by zero|multiply with overflow|add with overflow|subtract with overflow)/g,
  /(?:range start|range end) index [\w ]{0,32}|out of range for slice of length/g,
  /memory allocation failed, out of memory|capacity overflow/g,
  /a formatting trait implementation returned an error[\w ]{0,60}/g,
  /\*\* NoAllocator::alloc\(\) does not allocate memory \*\*/g,
  /Unable to find a viable program address bump seed/g,
  /invalid (?:value|length|type): |, expected |an array of length \d+/g,
  /(?:struct|tuple|newtype) variant |struct \w+ with \d+ elements?/g,
  /variant index \d+ <= i < \d+/g,
  /The arguments provided to a program instruction were invalid/g,
  /An (?:instruction's|account's) data contents (?:was|were) invalid/g,
  /entrypointsol_\w+/g,
];

// The framework error catalogues. Anchor, solana-program and Rust's std::io
// each embed their full error enum — names *and* human messages — into every
// binary that links them. Measured on the live index this is the single
// biggest source of corpus mass, and it cannot be removed by exact-string
// dedup: the extractor fuses each catalogue onto adjacent program-specific
// literals, so every copy is byte-unique even though the content is identical.
// Left in, a query for "token" or "mint" matches essentially every Anchor
// program and the search is worthless. Stripped as substrings instead.
const ANCHOR_ERRORS =
  /(?:instructionmissing|instructionfallbacknotfound|instructiondidnot(?:de)?serialize|idlinstruction(?:stub|invalidprogramid)?|idlaccountnotempty|eventinstructionstub|constraint(?:mut|hasone|raw|owner|rentexempt|seeds|signer|executable|state|associatedinit|associated|close|address|zero|space|accountisnone|token(?:mint|owner|tokenprogram)?|mint[a-z]{0,45})|require(?:keys)?(?:eq|neq|gte|gt)?violated|accountdiscriminator(?:alreadyset|notfound|mismatch)|accountdidnot(?:de)?serialize|accountnotenoughkeys|accountnotmutable|accountownedbywrongprogram|invalidprogramexecutable|accountnot(?:systemowned|initialized|programdata)|accountsysvarmismatch|accountreallocexceedslimit|accountduplicatereallocs|declaredprogramidmismatch|tryingtoinitpayerasprogramaccount|invalidnumericconversion|anchorerror[a-z ]{0,30}|deprecated)/g;

const ANCHOR_MESSAGES =
  /(?:an? |the )?[a-z_ ]{0,60}constraint (?:was violated|is none)|a require(?:_[a-z]+)* expression was violated|(?:the (?:program|account|given|declared|api)|no 8 byte|8 byte|failed to (?:de)?serialize|not enough account keys|expected zero account|error during numeric|a required account|idl account must be empty|you cannot\/should not)[a-z0-9_ ,.\/-]{0,90}/g;

const SOLANA_ERRORS =
  /(?:maxseedlengthexceeded|invalidseeds|illegalowner|invalidargument|invalidinstructiondata|invalidaccountdata|accountdatatoosmall|insufficientfunds|incorrectprogramid|missingrequiredsignature|accountalreadyinitialized|uninitializedaccount|notenoughaccountkeys|accountborrowfailed|borshioerror|accountnotrentexempt|unsupportedsysvar|maxaccountsdataallocationsexceeded|invalidrealloc|maxinstructiontracelengthexceeded|builtinprogramsmustconsumecomputeunits|invalidaccountowner|arithmeticoverflow|programerror|pubkeyerror)/g;

const IO_ERRORS =
  /(?:wouldblock|osmessageerror|customerror|connection(?:refused|reset|aborted)|hostunreachable|networkunreachable|networkdown|notconnected|addrinuse|addrnotavailable|brokenpipe|alreadyexists|notadirectory|isadirectory|directorynotempty|readonlyfilesystem|filesystemloop|stalenetworkfilehandle|invalidinput|invaliddata|writezero|storagefull|notseekable|quotaexceeded|filetoolarge|resourcebusy|executablefilebusy|crossesdevices|toomanylinks|invalidfilename|argumentlisttoolong|interrupted|unexpectedeof|outofmemory|inprogress|uncategorized|permissiondenied|deadlock|timedout|notfound)/g;

const BORSH_ERRORS =
  /(?:invalid(?:utf8|bool|char|tag)encoding|deserializeanynotsupported|sizelimit|sequencemusthavelength|utf8error|valid_up_to|error_len)/g;

/** Digit tables (the 0..99 lookup every Rust binary embeds) and long hex runs. */
const DIGIT_RUN = /\d{8,}/g;
const HEX_RUN = /(?:0x)?[0-9a-f]{24,}/gi;

/** Strip the compiler's noise out of one recovered string, keeping whatever
 *  the developer actually wrote. Returns "" when nothing survives. */
function denoise(s: string): string {
  if (ELF_SECTIONS.has(s.trim())) return "";
  if (TOOLCHAIN_PATH.test(s)) return "";
  // case-sensitive boilerplate first (it is emitted verbatim), then fold case
  // so the catalogue patterns can stay lowercase-only
  let out = s;
  for (const re of BOILERPLATE) out = out.replace(re, " ");
  out = out.toLowerCase();
  // catalogues before the generic filters — they run longest-first so a
  // stripped enum name can't leave a fragment that looks like a real token
  for (const re of [ANCHOR_MESSAGES, ANCHOR_ERRORS, SOLANA_ERRORS, BORSH_ERRORS, IO_ERRORS]) {
    out = out.replace(re, " ");
  }
  out = out.replace(HEX_RUN, " ").replace(DIGIT_RUN, " ");
  // collapse whitespace and any run of non-identifier punctuation
  out = out.replace(/[^\w./:@-]+/g, " ").replace(/\s+/g, " ").trim();
  // a residue of single chars and 2-char fragments is not worth indexing
  if (out.length < 4) return "";
  return out;
}

/** Build the flat, lowercased corpus for one subject. Declared identity goes
 *  first so a prefix match on the blob still favours the real name. */
export function buildSearchText(parts: SearchTextParts): string {
  const chunks: string[] = [];
  const push = (v: string | null | undefined): void => {
    if (typeof v === "string" && v.trim()) chunks.push(v.trim());
  };

  push(parts.name);
  push(parts.repoUrl);
  push(parts.website);
  push(parts.social);
  push(parts.category);
  push(parts.framework);
  for (const i of parts.integrations ?? []) push(i);
  for (const c of parts.capabilities ?? []) push(c);
  for (const i of parts.idlInstructions ?? []) push(i);

  // the developer's own declaration — the highest-trust text we ever get
  if (parts.securityTxt) {
    for (const [k, v] of Object.entries(parts.securityTxt) as [string, string][]) {
      if (k === "encryption" || k === "expiry") continue; // keys/dates, not words
      push(v);
    }
  }

  // …and the bytecode residue, which is the only text most programs have
  for (const s of parts.strings ?? []) {
    const clean = denoise(s);
    if (clean) chunks.push(clean);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  let total = 0;
  for (const c of chunks) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (total + key.length > MAX_TEXT) break;
    deduped.push(key);
    total += key.length + 1;
  }
  return deduped.join("\n");
}

/** Base58 program ids are 32–44 chars. Used to route "paste an address" input
 *  straight to a dossier instead of running a text search on it. */
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeProgramId(value: string): boolean {
  return BASE58_ID.test(value.trim());
}

/** Escape a user query for a SQL LIKE pattern (\ % _ are wildcards). */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
