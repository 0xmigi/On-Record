---
name: brief
description: Explain one Solana program to Ash completely, in a single pass, so he finishes the first read able to explain it to someone else. Load this WITHOUT being asked as soon as he settles on one program — "let's go with X", "I'm writing about X", "tell me about X", "explain this one", or naming a program after a triage. Also load it when he asks what a program does or means and the answer needs more than a sentence. Writes the entry to docs/programs/. It does NOT write the post.
---

# Brief

One program, understood completely, in one pass.

## The standard this is held to

Ash has said the slow part of every post is not the decode — it is the stretch
where he keeps asking questions until he is satisfied the thing is actually
interesting. On the flint post the technical decode was right early and it still
took several rounds, because the briefs led with data and left him to assemble
the meaning.

So the bar here is: **he finishes this document able to explain the program to
someone else, without asking a follow-up.** If he has to ask "but what does that
actually mean", the brief failed.

He is the name on the account and has to defend every claim unprompted,
including questions the post never answers.

## Get the evidence first

```
GET https://on-record-api-production.up.railway.app/api/programs/<id>/dossier.md
```

Read all of it, including "What is not known" — that section is the spine of the
"if someone presses" material below. Then go past it: the IDL, the repo if there
is one, the project's own docs, any announcement. Label every source.

Anything the dossier flags as unsampled or unknown stays unknown. Do not fill a
gap with a plausible guess.

## Write it in this order

Meaning first, evidence under it. The order matters — a reference-book ordering
(background, architecture, deployment) is what leaves him assembling.

**1. The gap, in two sentences.** The two facts that don't sit comfortably
together. If there is no gap, say so in one line and stop writing — the entry
still gets saved, but it is a no.

**2. What it is, from the floor up.** The section the whole document exists for.

- Assume no finance, no cryptography, no domain background. He is not a quant
  and will not pose as one.
- Any term the program's world takes for granted — market maker, shielded pool,
  order flow, nullifier, batch auction — gets explained with a **physical
  analogy before the term is used**, not after. A market maker is a card shop
  that will buy your card for $9 and sell it for $11, always, right now; the
  spread is the whole business. That is the register.
- Then connect the explanation back to the specific strings, handlers or
  accounts in this binary, so the concept and the evidence arrive together.
- Full sentences with clauses. Never a comma-delimited list of attributes — he
  has called that bullet points crammed into a sentence.

**3. The mechanism.** The one unusual thing this program does, decoded, with the
exact evidence it came from — handler names, source tree, syscalls, payload
shape, account layout.

**4. Unusual compared to what.** Corpus-relative, always, straight from the
dossier: multiples of the framework median, percentile, syscall rarity as "N of
M programs on record". An adjective with no comparison attached is not a claim.

**5. Who, and how confident.** Authority class and threshold, funding, declared
entity, devnet incubation. Distinguish what the chain shows from what a
security.txt or a website asserts — a security.txt names an entity, it does not
prove one.

**6. If someone presses.** Three explicit lists, the format proven in
`docs/posts/chancery.md`:
- **Verified** — claim, value, and the method that produced it.
- **Inference** — labelled as inference, with the chain of evidence and how
  strong it is.
- **Do NOT claim** — the things that look supported and are not, plus anything
  previously believed and since disproved.

**7. The case against posting it.** The strongest argument that this is nothing.
Written every time, unprompted. Both of the radar's known misfires were
confident, and a self-rebuttal is the cheapest guard against a third.

## Rules

- **Never write in post voice here.** No hook, no lowercase affect, no closer.
  This is for understanding; the post is a separate step.
- **Never claim usage from a raw transaction count.** Use the dossier's
  invocation share, cadence and per-payer split. A program whose traffic is
  mostly its own upgrade authority is not adopted, whatever the count says.
- **Report the vantage honestly.** "The recovered architecture is all
  market-maker terminology" — not "real trading-desk machinery", which claims a
  recognition he doesn't have.
- **Purpose is never recoverable from bytecode.** Anything about intent is
  inference and says so.

## Output

Write to `docs/programs/YYYY-MM-DD-<name>.md`, then give him the document in
chat — he should not have to open a file to read it.

End with one question only: whether to draft the post. Nothing else.
