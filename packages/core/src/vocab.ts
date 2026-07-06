// ---------------------------------------------------------------------------
// Vocabulary rules (spec §1.3). Two jobs:
//  1. the table injected into writer prompts
//  2. the banned-jargon regexes the verify stage enforces on story bodies
// ---------------------------------------------------------------------------

export const VOCABULARY_TABLE = `
| Chain term | Say instead |
|---|---|
| program | app / project (or just its name) |
| deploy / deployed | launched / went live |
| upgrade / upgraded | shipped an update / updated |
| upgrade authority | who can change it |
| authority is a hot wallet | controlled by a single key |
| authority is a multisig / governance | controlled by a team key / by governance |
| authority is none | frozen — no one can change it |
| verified build | code is public and matches |
| unverified | code is not public |
| TVL | $X held in it |
| devnet | the lab / test network |
| clones / forks | copies |
`.trim();

// Words that must never appear in a published headline or body. Program IDs,
// slots and signatures live on the receipts layer only.
export const BANNED_JARGON: { pattern: RegExp; term: string }[] = [
  { pattern: /\bprogram\b/i, term: "program" },
  { pattern: /\bdeploy(?:ed|ment|s)?\b/i, term: "deploy" },
  { pattern: /\bupgrade authority\b/i, term: "upgrade authority" },
  { pattern: /\bBPF\b/i, term: "BPF" },
  { pattern: /\bloader\b/i, term: "loader" },
  { pattern: /\bProgramData\b/i, term: "ProgramData" },
  { pattern: /\bbuffer\b/i, term: "buffer" },
  { pattern: /\bmultisig\b/i, term: "multisig" },
  { pattern: /\bTVL\b/, term: "TVL" },
  { pattern: /\bdevnet\b/i, term: "devnet" },
  { pattern: /\bmainnet-beta\b/i, term: "mainnet-beta" },
  { pattern: /\binstruction\b/i, term: "instruction" },
  { pattern: /\bIDL\b/, term: "IDL" },
  { pattern: /\bbytecode\b/i, term: "bytecode" },
  { pattern: /\bslot\b/i, term: "slot" },
  { pattern: /\bsignature\b/i, term: "signature" },
  { pattern: /\bfork(?:s|ed)?\b/i, term: "fork" },
  // base58 blobs (addresses / signatures) don't belong in story text
  { pattern: /[1-9A-HJ-NP-Za-km-z]{32,}/, term: "raw address/signature" },
];

export function findJargon(text: string): string[] {
  return BANNED_JARGON.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

export const LIMITS = {
  headline: 90,
  body: 320, // hard limit; 280 is the target communicated to the writer
  inference: 200,
} as const;
