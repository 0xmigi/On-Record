# On Record

An on-chain-first radar for novel Solana programs. Ash uses it to find programs
worth writing about, then posts about them on X as @0xmigi.

## The morning routine

Ash brings programs — usually pasted `on-record.azuolas.xyz/p/<id>` links, often
with a note on how he found them. He talks; he does not type commands. Never
hand him a command to run or a skill to invoke. Recognise what he's doing and
load the right instructions yourself.

1. **He pastes programs** → load the `triage` skill without being asked. Short
   verdict each, one pick.
2. **He picks one** → the deep one-shot brief. The goal is that he finishes it
   already able to explain the program to someone else, first read, no rounds.
3. **He's satisfied it's interesting** → draft the post.

Post artifacts live in `docs/posts/<name>.md`, research entries in
`docs/programs/`. `docs/posts/chancery.md` is the reference format: posted
version, verified-facts table with a method column, inferences labelled as
inferences, and an explicit "do NOT claim" list.

## Rules that have been learned the hard way

- **Ash decides what is interesting — never gate his choices.** Report what a
  program is and what stands out; don't apply a bar. Things have been worth
  posting for unrelated reasons: something didn't add up, or he could see it
  before it was announced, or it belongs to a project people follow, or the
  mechanism was just worth looking at (his best-performing post ever was a
  diagram of how a transfer works, with no anomaly in it).
- **Don't rank by the interest score either.** It has misfired in both
  directions — rated a coin-flip casino highly, rated a genuinely novel
  market-making engine a "variant".
- **Never claim usage from `txns24h`.** It has been wrong twice — once counting
  one identical transaction repeated on a timer, once counting the deployer's
  own loader close operations. Activity claims come from sampled, parsed
  transactions or they don't get made.
- **"Unusual" is always corpus-relative.** Give the comparison, not the
  adjective.
- **Ash is not a reporter, a quant, or a source of truth**, and won't pose as
  one. Report what the tool recovered from the binary. Never write in a voice
  that implies expertise he doesn't claim.
- **Every claim gets fact-checked against on-chain or binary data before he
  posts.** He relies on this for the "if someone presses" safety.

Full drafting-voice rules live in the user's memory note `onrecord-post-craft`.
Read it before drafting anything.

## Toolchain

- **The LLM dossier is the way to read a program.** `GET <api>/api/programs/<id>/dossier.md`
  returns the whole picture as text — corpus-relative comparisons, recovered
  source tree, sampled traffic, provenance on every line, and an explicit
  "what is not known" section. Use it before opening a browser or writing
  queries. Source: `apps/ingest/src/dossier.ts`.
- Backend is Railway (`https://on-record-api-production.up.railway.app`),
  frontend is Vercel, both auto-deploy from `main`.
- Global pnpm crashes under Node 23 — use per-package `tsc` binaries.
- `node scripts/inspect.mjs <programId>` dumps printable strings and Rust panic
  source paths from a program's bytecode. The source tree is recoverable ~85% of
  the time even on fully anonymous programs.
