# Daily content routine

Scheduled agent, runs 07:00 local, writes into `docs/programs/`. Purpose: by the
time Ash sits down, he already fully understands one or two real programs and can
decide what to post. The routine never writes posts.

## Why this shape

Week of 2026-07-23 → 07-29: every post was written by Ash from scratch after
discarding drafts. What actually got used was verified facts, corrections, and
explanation. So the routine produces understanding, not copy.

The output is a **full encyclopedia entry** — not a fact list. Ash is the name on
the account and has to be able to defend every claim unprompted, including
questions the post doesn't answer.

## Daily flow

1. Pull last 24h of deploys from the radar API, mainnet **and** devnet.
2. Shortlist on: IDL present, security.txt, unusual syscalls, unusual
   size/framework, real lineage or incubation, a meaningful name, or a high
   interest score.
3. Rank, take the top 1–3.
4. For each: full dossier, strings, usage, authority + funding chain, IDL,
   any public repo or site it points at.
5. Write one file per program: `docs/programs/YYYY-MM-DD-<name>.md`.
6. If literally nothing clears step 2, write `docs/programs/YYYY-MM-DD-none.md`
   with one paragraph on what was seen. Never invent a candidate.

Devnet counts. The Helius shielded-pool find was devnet and it was the best
material of the week — pre-launch is where the interesting things are.

## Entry format

Verdict block first so a boring one can be abandoned in ten seconds. Then the
full article, which is read only if the verdict earns it.

```
---
program: <id>
network: mainnet | devnet
name: <name or "unnamed">
date: YYYY-MM-DD
verdict: deep post | short post | no post
---

# <name>

**Verdict:** one sentence — is this worth posting, and why or why not.
**In one line:** what the program is.
**Compared to:** gator (strong) / chancery (medium) / a plain variant.

## Lead

Encyclopedia lead paragraph: what it is, who deployed it, when, what state it
is in. Written so someone who knows nothing finishes the paragraph knowing what
the thing is.

## Background

Where it came from. Lineage, incubation, related deploys, the team if publicly
identifiable, any prior version.

## What it does

The mechanism, in plain language, written for someone who knows nothing about
it. No jargon that isn't
defined in the same sentence. This is the section Ash reads to become able to
explain it to someone else.

## Architecture

Modules, instructions, accounts, syscalls — what they are and what they imply.
Recovered from binary strings, IDL, and any public source.

## Deployment

Deploy dates, upgrade count, authority and its class, cost, size, framework,
verification status, disclosures.

## What cannot be determined

Explicit. Every claim that would need a source Ash does not have. This section
is the "if someone presses" safety net and is never omitted.

## Sources

What was read, and what was not. Distinguish on-chain evidence from a project's
own marketing.
```

## The bar, for the verdict line

**Deep post** — something is unexplained or contradictory. A rare primitive with
no stated purpose, machinery with no usage, a claim that conflicts with the
chain, a capability change nobody announced. gator and chancery both cleared
this.

**Short post** — genuinely interesting but explicable. One observation, the
dossier link, no investigation. This is the volume tier and most days should
land here.

**No post** — the program is exactly what it says it is. Write the entry anyway;
the understanding still compounds and the family may matter later.

A program is not postable merely for being new. ~157 mainnet deploys a day, 93%
opaque — new is the baseline, not the signal.

## Volume

Target is daily posting, mixed sizes. The entry is what makes a short post cheap:
with the program already understood at 07:00, a short post is ~20 minutes. Deep
posts stay at 1–2 a week and are the exception, not the standard.

## What the routine cannot do

External triggers — livestreams, announcements, launches — are invisible to the
radar. Ash brings those; the same entry format gets produced on demand from a
repo, stream or docs site.

## Open

- Does the shortlist need a size or usage floor to keep noise down?
- Should families/clusters get one entry rather than one per program?
