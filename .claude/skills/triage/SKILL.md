---
name: triage
description: Triage Solana programs Ash has found and say which is worth a post. Load this WITHOUT being asked whenever he pastes one or more on-record.azuolas.xyz/p/ links or bare program ids, or says anything like "what do you think of these", "what do you make of this one", "found a couple programs", "anything here worth posting", "look at these" — including when he pastes them with no question at all. Also load it any time the task is picking which find to write about. Produces a short ranked verdict per program and one recommended pick; it does NOT write posts.
---

# Triage

Ash pastes 1–8 programs, usually as `on-record.azuolas.xyz/p/<id>` links, often with a
note about how he found them. Return a short verdict on each and one pick.

This is the first block of the morning routine. It is a **filter**, not an
investigation. Budget ~150 words per program. The deep one-shot brief is a
separate step that runs only on the program he picks.

## The bar: find the gap

A program is postable when two facts about it don't sit comfortably together.
That is the selection rule every shipped post has satisfied — not novelty, not
rarity, not the interest score.

- gator — a live model publishing 2.1 MB/day every 40s, and the engine that
  consumes it has fired 7 times out of 200.
- chancery — a finished 70-instruction regulated-issuance machine, one hot
  wallet, zero instructions ever called.
- flint/sweetspot — trading real volume on mainnet for six weeks, announced
  yesterday.
- colosseum-client — markets itself as fully on-chain PvP, decodes to an RNG
  coin flip.

No gap, no post. Say that plainly and move on — a fast, flat "nothing here" is
worth as much as a yes, and dressing up deploy churn has burned an afternoon
before.

**Second term: attachment.** A gap on a program nobody is watching is a quiet
post. A gap on something with a name, a team, a token or an audience is the one
that travels — the Helius post did ~1K views against 357 because 5,700 people
already followed that team. When two programs both have a gap, pick the one
attached to something people already track.

**How he found it is evidence.** If he says a program came from a livestream, a
project he follows, or an announcement he saw, that context outranks every score
in the dossier. Five of six shipped posts started from a name or an external
event, not from the radar's novelty ranking.

## Gathering

**Start here, for every program:**

```
GET https://on-record-api-production.up.railway.app/api/programs/<id>/dossier.md
```

Plain text, built for this job. It carries the things that are otherwise
invisible or expensive: corpus-relative size and syscall rarity, the recovered
source tree, family size with its closed count, and a **sampled** traffic read
with cadence, invocation share and payload shape. Every line states how it was
derived, and it ends with an explicit list of what is not known — read that
section, it is the "if someone presses" material.

`?sample=0` skips transaction parsing when you only need the static picture.

Fetch all programs in parallel. Don't serialize the batch.

Only reach for more when the dossier leaves a specific question open:

```
/api/programs/:id        full JSON record
/api/programs/:id/idl    the published IDL, if any
node scripts/inspect.mjs <programId>    raw bytecode strings
```

The dossier already reports whether the program is on mainnet or devnet, so the
`?network=` in a pasted URL is confirmation, not input.

## Hard rules

- **Never state usage from `txns24h`.** That field has lied twice: gator's
  2,176/day were one identical transaction on a 39.7-second metronome, and
  mayhem's ~1,666/day were the deployer's own loader close operations, not
  invocations. Any claim about activity comes from sampled, parsed transactions
  or it doesn't get made.
- **Unusual is always corpus-relative.** "11× the pinocchio median, top 7% of
  830", "2 of 2,412 programs import this syscall". A bare adjective is noise.
- **Label inference as inference.** Say what's decoded, what's inferred, and
  what can't be determined from here.
- **Don't write in post voice.** This is analysis for Ash, not copy. No hooks,
  no lowercase affect, no closers.
- **Don't posture.** Report what the tool recovered. Never imply domain
  expertise he doesn't have and won't claim — he surfaces programs, he is not a
  reporter or a quant.
- **Flag radar bugs as you hit them.** A dossier that contradicts the chain (a
  16-month-old program badged NEW, `idlPresent: false` next to a live IDL) is
  worth a line at the end. These have been real every time.

## Output

One section per program, ordered most to least interesting. Heading carries a
verdict label — not a neutral title:

```
## <name or id-prefix> — the most interesting one
`<id>` · mainnet · deployed 5 Aug 2026

<the tell: the specific decoded thing that says what this is — syscalls,
handler names, source tree, transaction shape. Two or three sentences.>

**The tension:** <the two facts that don't fit. Or "none — it is exactly what
it says it is," and stop.>
```

Then close with:

- **The pick** — one program, one sentence on why it beats the others.
- **What I'd skip, and why** — one line each. Explicit, so a no is as legible
  as a yes.
- **Radar notes** — any dossier/chain contradictions found along the way.

End by asking which he wants to take forward. Nothing else — do not start
researching the winner in the same turn.
