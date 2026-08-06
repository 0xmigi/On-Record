---
name: draft-post
description: Draft an X post for Ash (@0xmigi) about a Solana program he has decided to write about. Load this WITHOUT being asked when he says anything like "let's write it", "draft the post", "put it in post form", "how would you write this", or approves drafting after a brief. Applies the craft rules from the first attempt, not the fourth.
---

# Draft the post

## Read this first, every time

The voice rules live in the user's memory note **`onrecord-post-craft`**. Read
it before writing a word. It was distilled over ~25 rounds of him rewriting my
drafts across four posts, and every rule in it exists because I broke it.

The reference artifacts are `docs/posts/chancery.md` and
`docs/posts/gator-oracle.md` — posted version, verified-facts table, inference
list, do-not-claim list.

## The failure mode this skill exists to prevent

The drafts he rejected did not fail on structure. They failed on posture and on
source blur, in the same four ways, every time:

- **Expert posture.** "real trading-desk machinery", "the part that made me
  stop", "market-maker vocabulary i had to look up". He surfaces programs. He is
  not a quant, not a reporter, and not a source of truth — and his following
  knows it. Report what the tool recovered.
- **Source blur.** What the binary shows and what an announcement or SDK says
  are separate, and the on-chain find comes first. Label the downstream source
  after it — "reading the sdk and announcement post then clarified it".
- **Announcing the tool.** The find is sourced to On Record by implication —
  "came up on the radar", "digging into the bytecode" — never a literal "what On
  Record recovered:" heading.
- **Aphorism closers.** "the interesting bit isn't another defi app — it's X".
  End on a fact. The flint post landed on "the matching + settlement happen
  on-chain", and dropping the closer was what finished it.

Also: past tense throughout, first person, all lowercase including "i", and the
hook inside the first ~3 sentences before X collapses the post.

## Before drafting

Every factual claim must trace to the brief's verified list or the dossier. If a
claim isn't there, either go verify it or cut it. He leans on this for the "if
someone presses" safety and has asked for it explicitly on every post.

Check the brief's **do-not-claim** list and honour it.

## Output

One draft. Not three variants — he rewrites heavily himself, and a menu makes
that harder, not easier.

Then, separately and briefly:
- any claim in the draft that is inference rather than fact, flagged
- anything a pedant could poke, stated plainly

Do not offer a "tightened pass" or ask which closer he prefers. Give him one
thing to edit.

## After it ships

Append the posted version to `docs/posts/<name>.md` with the date and URL, and
note what structure was used — the structures that land feed the eventual
auto-publish work.
