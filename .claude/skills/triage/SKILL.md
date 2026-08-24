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

## What makes one worth telling him about

**Ash decides what is interesting. This skill does not gate — it reports.** Say
what each program is and what stands out about it, and let him pick. Do not
withhold a program because it fails some test, and never manufacture a reason to
make one sound better than it is.

There is no single bar. The posts that have shipped, or that he was angry about
nearly missing, got there for genuinely different reasons:

- **Something doesn't add up.** gator's model publishing 2.1 MB/day while the
  engine consuming it had fired 7 times in 200. Chancery's finished
  70-instruction machine, one hot wallet, never called. Colosseum marketing
  fully-on-chain PvP and decoding to a coin flip.
- **He can see it before anyone has said anything.** The TapeDrive token
  launcher on devnet. Flint trading on mainnet for six weeks before the
  announcement. Earliness is the product; it needs no contradiction.
- **Whose it is.** A project or team people already follow, doing something new.
  Nothing has to be wrong with it; this is often the strongest reason.
- **The mechanism is worth looking at on its own.** The Helius transfer
  diagram — his best-performing post ever — just showed how a thing works. No
  anomaly, no verdict, no takedown.

So: report what the program is, then say plainly what stands out and which of
these it is, if any. "Nothing stands out — it is exactly what it says it is" is
a legitimate and useful answer, delivered flatly and fast.

**What travels further.** Attachment to something people already track beats
mechanism novelty on reach — the Helius post did ~1K views against 357 because
5,700 people already followed that team. Worth saying when two are close, but it
is a note for him, not a filter.

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

**The dossier tells you what the binary is, not what the product is.** It cannot
answer "why does this exist". For that, go to what the deployer published — the
website, the repo, the README, the actual Rust source if the repo is live. A
declared repo with source in it beats every recovered artefact, and reading it
is usually two calls. Do this before writing, not after he asks.

Only reach for more when a specific question is still open:

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
- **Never lead with forensics.** Handler counts, syscall names and rarity tiers,
  kilobytes, section sizes, TLSH distances, novelty scores, percentile-of-corpus
  — these are how you *worked it out*, not what you found. They belong in the
  brief, or in one clause backing a specific claim, never as the description of
  a program. He has said this outright: he wants to know what it does and why it
  exists, not how many instructions it has.
- **Never use a "The tension:" section, or any relabelled version of it.** No
  bolded lead-in that sets up a contradiction — not "The tension", "The catch",
  "What doesn't fit", "The wrinkle", "The twist". Whatever doesn't add up gets
  said in the prose, in the same voice as everything else. The only bolded
  labels in the whole output are the three closers.
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

<What it does, in plain language, first sentence. Then: why it exists — what
problem it is for, who it is for. Then: what system it belongs to — the product,
the other programs around it, where it sits in that machine. Then: why it is on
the radar today — what changed, what he is actually looking at. Then anything
that doesn't add up, in the same prose. Four to six sentences.>
```

Answer these four, in this order, for every program:

1. **What does it do?** In a sentence a person could repeat.
2. **Why does it exist?** The problem it is for.
3. **What system is it part of?** The product, the sibling programs, the layer.
4. **Why am I seeing it now?** What changed today.

If a program cannot answer them — anonymous, no strings, nothing published —
say that plainly in two sentences and move on. "I can't tell you what this does
and here is why" is a complete answer. Padding it with structural measurements
is not.

Then close with:

- **The pick** — one program, one sentence on why it beats the others.
- **What I'd skip, and why** — one line each. Explicit, so a no is as legible
  as a yes.
- **Radar notes** — any dossier/chain contradictions found along the way.

End by asking which he wants to take forward. Nothing else — do not start
researching the winner in the same turn.
