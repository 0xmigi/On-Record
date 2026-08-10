# pumpsnipe — handoff

Working directory: `~/code/On-Record/experiments/pumpsnipe`

## State: FINISHED AND WOUND DOWN. Nothing left on chain, funds returned.

**The signing key is `sniper-keypair.json`, not the machine's default.**
`client/keypair.mjs` resolves `KEYPAIR` env -> `sniper-keypair.json` ->
`~/.config/solana/id.json`, and the runner prints which one it used. The
dedicated key exists so an auto-signing loop cannot reach anything but its own
trading capital, and so the identity that ends up in a published run log is a
deliberate choice rather than the machine default. It is gitignored; the file is
the only copy.

A pump.fun launch sniper in Pinocchio, built to be written about.

Deployed and closed on mainnet, 2026-08-07. The program no longer exists on
chain; its 0.09847704 SOL of rent came back in full.

| | |
|---|---|
| Program id | `EtGHq2pnMpctk7fAHX4HKbc3NGAtd5CzkqRuwidgXeSa` |
| Upgrade authority | `54XX52641Jq97e68uhz16xtmSDw4j9Ui9cTtYQEjDvsh` (the sniper key) |
| Data length | 13,976 bytes exactly, via `--max-len` |
| Rent locked | 0.09847704 SOL, refundable on close |
| Deploy signature | `49cxCVYkLoDjhJv7Wq2FgnB8fyeE4vSudNXdKRLy5kC5DVU1eReYicBqngEwhP1AXZ3CcmKBBdoJk8W2aeUm9n5s` |

On-chain bytecode was dumped and compared byte-for-byte against the local
artifact that passed the fork test — identical.

### First live run, 2 snipes, 2026-08-07

**Helius Sender works.** Region `ewr` measured 16 ms and the first snipe landed
66 ms after build.

```
1. Fomohog   LANDED  310378.671703 tokens   sig yDmmnAwuoC38…uUyX
2. MESSI     lost    NotAuthorized (Custom 6000) at fee_recipient.rs:19
launches seen 2 · fired 2 · landed 1 · detect-to-built median 14 ms
```

Fomohog's creator bundled 2 SOL and then sold it. The curve is now *below* where
we bought: the 310,378 tokens sell back for ~0.00868 SOL against 0.01 paid. That
is the sniper working exactly as designed and the trade still losing — the gate
protects against buying a curve that already ran, not against a creator dumping
after you fill.

Wallet: 0.15029152 -> **0.13307376 SOL**.

Funding came from `Fh546yBxtSaxCfytau9WnbdGMtcCJzaEQ6Tt1y2oHsz7` (0.25 SOL,
2026-08-07), which is where a sweep should go back to.

### The full session, 2026-08-07

10 snipes at 0.008 SOL, gate at baseline + 2 SOL, wallet floor 0.015.

```
fired 10 · landed 7 · lost 3 (all Custom 7 = LOST_THE_RACE, the gate)
detect to built, median 8 ms
fee pools: B:6  A:4      zero NotAuthorized
```

Every one of the three losses was our own gate refusing the trade, which is the
program doing precisely the job it exists for. The pool fix held on all ten, and
the split was 6 B to 4 A — a run that hardcoded either pool would have thrown
away most of the budget.

**Final, realised — not marked:**

| | SOL |
|---|---|
| sent to the sniper wallet | 0.250080 |
| returned after selling everything and closing the program | **0.197661** |
| **net cost of the experiment** | **0.052419** (≈21%) |

The sweep back is
`4usLbExk2kFL1PJtxdH9ktLkd8aEYG5hsViqF8n3M36MU2inQAHoWXHqWaEWLeaLDSNLmdAQHco8zJH6MCiX1UJa`,
2026-08-07 22:21 UTC. Sniper wallet is at 0.000000, no positions held, program
closed, all token accounts closed.

Note where the loss is **not**: the program's 0.098477 SOL of rent came back in
full, so infrastructure cost nothing. The 0.0524 is trading losses, eight 0.001
Sender tips, and transaction fees. The tip alone is 12.5% of an 0.008 position —
at this size the tip is a serious drag, and worth saying so in the writeup.

**Mid-session snapshot, kept because the decay is the story:**

| | SOL |
|---|---|
| in the wallet | 0.054505 |
| 8 token positions, marked at the curve | 0.074408 |
| token-account rent (recoverable by closing them) | 0.016314 |
| program rent (recoverable on close) | 0.098477 |
| **total recoverable** | **0.243705** |

Net **-0.006295 SOL, about -2.5%**, before pump.fun's ~1% sell fee. The trading
itself was slightly up — 0.056 SOL deployed across the seven session fills is
marked at 0.0657 — and the overhead ate it: seven 0.001 tips, fees on ten
transactions, and the losing trade from the validation run.

The distribution is the story, not the average. Of eight positions, one is up
~4.6x (0.008 -> 0.037) and four are down 50-82%. That is what sniping the median
launch buys you.

Positions are marked against the bonding curve and move violently; the 4.6x can
be zero within minutes. **`client/sell.mjs` sells the positions** — see below.

### Selling: use `sell_v2`, not `sell`

`client/sell.mjs` sells every position and closes each emptied token account to
reclaim its rent. It does not use the sniper program — that wraps `buy` only,
and there is nothing to gate on the way out.

```bash
node client/sell.mjs                       # simulate everything, send nothing
node client/sell.mjs --send                # sell, and close the emptied accounts
node client/sell.mjs --send --sweep <addr> # ...then send the remainder to <addr>
node client/status.mjs                     # what is in the wallet right now
```

No environment variable needed: `client/env.mjs` reads `HELIUS_API_KEY` out of
the repo's .env. Forgetting to export it used to surface as
`401 Unauthorized` thrown from inside web3.js, which reads like a broken script
rather than a missing variable.

`client/status.mjs` is the "did that work?" command — SOL balance, any position
still held, any emptied token account still holding rent, and whether the
program is really closed. Note a closed program is not deleted: the account and
its ProgramData survive as husks with zero lamports, so checking existence
always says "still there". Check ProgramData's lamports instead.

Verified: **8/8 positions simulate cleanly.**

The legacy 16-account `sell` (`33e685a4017f83ad`) does not work on these mints
and fails two different ways — 6073 wants a cashback `user_volume_accumulator`
it has no slot for, 6074 wants a `bonding_curve_v2` remaining account. Same
retirement the buy side hit. Use **`sell_v2`**, `5df6823ce7e940b2`, 26 accounts,
args `(amount, min_sol_output)`.

`sell_v2` is the 27-account buy layout with the **global** volume accumulator
removed — a sell does not accrue global volume — so everything from index 19 on
shifts down by one:

```
18 sharing-config   19 user_volume_accumulator   20 its wrapped-SOL account
21 fee_config       22 fee program   23 system   24 event authority   25 pump
```

Getting that shift wrong gives `ConstraintSeeds` (2006) naming
`user_volume_accumulator`. The fee recipient obeys the same two-pool rule as the
buy side.

### SOLVED: the fee-recipient pool rule

`Global` holds **two pools** of fee recipients, and each launch accepts exactly
one of them. Offering the wrong one gets the whole transaction rejected with
`NotAuthorized`, which is what killed snipe 2.

**The selector is a single byte: bonding curve offset 81.**

```
byte 81 = 0  ->  pool A, Global offsets 162..386 stride 32
byte 81 = 1  ->  pool B, Global offsets 516..740 stride 32
```

Verified 11/11 against live landed buys with zero contradictions — every launch
whose buyer used a pool-A recipient had byte 81 = 0, every pool-B one had 1.
Byte 82 sits next to it, varies independently, and means nothing here.

**And that byte is in the CreateEvent**, in the two-byte gap between
`baseTokenProgram` and `quoteMint` that the decoder used to skip. Verified 6/6
that event flag 1 equals curve byte 81. So the pool is known at detection time
for free — no RPC, no round trip, no guessing.

Two details that cost time inside this:

- **The B array starts at 516, not 484.** The key at 484 is rejected, and 772
  would collide with the buyback region beginning at 773.
- **The buyback recipient is pool-independent.** One buyback (offset 805) works
  with both pools, so only account index 6 needs choosing.
- The error tells you which way you got it wrong: `fee_recipient.rs:19` means
  you offered A and it wanted B; `:35` is the reverse.

Confirmed on a fork, both pools and both gate paths — 4/4:

```
POOL A mint   PASS gate open (succeeds)   PASS gate closed (LOST_THE_RACE)
POOL B mint   PASS gate open (succeeds)   PASS gate closed (LOST_THE_RACE)
```

and across 20 live mainnet launches with `DRY_RUN=1`, which now **simulates**
the transaction it built rather than only constructing it:

```
simulated: accepted 11 · lost the race (gate held) 9
fee pools seen: A:18 B:2      detect to built, median 6 ms
```

Zero `NotAuthorized`. Every launch either went through or was correctly refused
by the gate. Pool B was 2 of 20 here and 7 of 16 in an earlier sample, so the
mix moves around a lot — hardcoding either pool would have failed badly.

## What it is

The program does one thing a client-side buy cannot: it re-reads the bonding
curve **at execution time** and refuses the trade if the curve already moved
past a bound you set. Losing the race costs a transaction fee instead of a bad
fill. Everything else is forwarded verbatim, so the program doesn't know or care
which pump.fun buy variant it's wrapping.

| | Anchor (discarded) | Pinocchio (current) |
|---|---|---|
| Binary | 192,560 B | **13,976 B** |
| Deploy rent | 1.34 SOL | **0.098 SOL** |

Program id (fork only): `EtGHq2pnMpctk7fAHX4HKbc3NGAtd5CzkqRuwidgXeSa`

## Files

```
src/lib.rs           the program, ~180 lines — unchanged this round
client/events.mjs    decode pump.fun's CreateEvent + TradeEvent from logs
client/stream.mjs    launch feed — ws | atlas | laserstream, same output
client/lift.mjs      derive the 27 v2 accounts; prewarm; harvest fee recipients
client/build.mjs     build the snipe transaction (shared by runner and test)
client/sender.mjs    Helius Sender submission, tip, region pick, confirm
client/hunt.mjs      the runner — detect, decide, fire, in one process
client/verify.mjs    fork test, both gate paths, with logs
client/check-derive.mjs  diffs the zero-RPC derive against the RPC one, live
client/snipe.mjs     older one-shot; superseded by hunt.mjs
client/watch.mjs     older detector; superseded by stream.mjs + hunt.mjs
```

## The Helius half — what is actually available

Measured against the real key, not read off a pricing page:

| | result | needs |
|---|---|---|
| LaserStream gRPC (mainnet) | `Unsupported plan type` | Business, $499/mo |
| Enhanced websockets (Atlas) | HTTP 403 | Developer, $49/mo |
| `logsSubscribe` on Helius mainnet ws | **works** | free |
| **Helius Sender** | **works** | free, all plans |

So the handoff's step 1 is blocked on plan, and step 2 is not. `stream.mjs` has
all three backends behind `TRANSPORT=`; LaserStream is a one-line switch if the
plan changes. Nothing downstream knows which is running.

**This is not the bottleneck it looks like.** The old detector's cost was not
the socket, it was what happened after: `watch.mjs` spawned `node
client/snipe.mjs` per launch (~40 ms just to boot) and the child then made four
sequential RPC calls. Removing those took detect-to-signed from ~350 ms to a
**median of 7 ms**, measured over 15 live launches. A faster transport would
shave tens of milliseconds off a path that no longer wastes hundreds.

## Things that cost hours — do not rediscover these

**Build flag is mandatory.** `cargo build-sbf --tools-version v1.52`. The default
platform-tools ships rustc 1.84; Pinocchio 0.11 needs 1.89. Without the flag it
either fails to resolve or **silently hands back a stale artifact and reports
success**.

**`slice-cpi` is a feature of `solana-instruction-view`, not pinocchio.** Use
`pinocchio::cpi::invoke_with_bounds::<MAX_ACCOUNTS, _>`.

**Dev-dependencies leak into the SBF build graph** and break it. The program
crate has exactly one dependency. Tests live in a separate crate.

**pump.fun's published IDL is wrong.** Both the corpus copy and the on-chain IDL
document `buy` with 16 accounts; live `buy` passes 18. Use
`buy_exact_quote_in_v2` — discriminator `c2ab1c46684d5b2f`, 27 accounts, args
`(spendable_quote_in, min_tokens_out)`. Bonding curve at index 10, user at 13.

**There is no anchor IDL account.** `["anchor:idl", program]` does not exist for
pump.fun, so the Global struct cannot be read from an IDL. Everything below was
recovered from live transactions.

**The fee recipient rotates, and no fixed offset works.** This is the one that
cost the most. Fourteen live buys used recipients sitting at Global offsets 41,
162, 194, 226, 290, 322 and 483 — and **two transactions in the same slot used
different ones**, so it is not slot-derived either. It is a membership check
against a set that changes. The old hardcoded offset 483 was a lucky sample; it
still appears in landed buys, but 676 and 741 do not work.

  Worse, the fee recipient (index 6) and buyback recipient (index 8) must be a
  pair that actually occurs together — mixing a valid 6 with a valid 8 from a
  different transaction still gives `NotAuthorized` from `fee_recipient.rs:35`.

  The fix is `harvestFeeRecipients()`: copy both off a buy the chain already
  accepted. Run once at startup and re-harvested every 5 minutes, never on the
  hot path. Note **22 of 25 recent pump.fun transactions fail**, so the harvest
  looks back 200 signatures to find a landed buy.

**`quote_mint` on the bonding curve is often all-zeroes**, meaning native SOL.
Fall back to WSOL, which is always classic SPL Token, never Token-2022.

**pump.fun mints are Token-2022.** Read the token program off the mint — or, now,
off the create event, which carries it.

**Curves do not all start at the same reserve.** Mainnet shows both 30 SOL and
4.292 SOL starting points, so an absolute gate is meaningless. The gate must be
relative to the curve's own start.

**Most creators buy their own token inside the create transaction** — 3 of 4
sampled launches, in sizes from 0.5 to 12.8 SOL. That buying is atomic with the
create and cannot be raced by anyone. So the gate is measured against
`baseQuoteReserves`, the curve as it stood when the create transaction finished,
not against its nominal start. Measured against the nominal start it would
reject nearly every launch for losing a race that was never run.

**Sender forwards to mainnet even when your RPC is a fork.** `hunt.mjs` routes
submission through the local RPC whenever the RPC URL is localhost, so a fork
test cannot leak real transactions. Do not remove that guard.

**A fork cannot mirror mainnet fast enough to test the hot path.** Running
`hunt.mjs` against surfpool fails at the ATA create with `Custom: 2`, because we
submit ~7 ms after the create lands on mainnet and surfpool has not fetched the
mint yet. That is a fork artifact, not a bug — the same mint passes `verify.mjs`
moments later, once the fork has the state. Use `verify.mjs` for correctness and
`DRY_RUN=1` against mainnet for timing.

## The event carries almost everything

pump.fun emits an Anchor `CreateEvent` on every launch, and the log line has the
mint, bonding curve, creator, base token program and quote mint in it. Layout was
recovered by decoding live events; `launchFromLogs` re-derives the curve PDA from
the mint and drops the launch if it disagrees, so a layout change makes us miss a
launch rather than fire at a misparse.

That removes the `getTransaction` round trip the old detector needed to find the
mint, and with a prewarmed global config it removes **every** RPC call from the
hot path. `check-derive.mjs` diffs the zero-RPC derivation against the proven
RPC one on live launches: **4/4 byte-identical, 3–4 ms versus 159–299 ms.**

`TradeEvent` (`bddb7fd34ee661ee`) is decoded from the same transaction to get the
creator's bundled buy and the post-create curve state.

## Measured, from a 15-launch mainnet dry run

```
detect to built, median 7 ms
gate would have passed 13/15 at +800 ms
others bought, median 0.0000 SOL  (min -0.0027, max 12.4211)
dev bundle, median 0.001 SOL  (9/15 bundled at all)
transaction size 1184 bytes  (limit is 1232 — only 48 bytes of headroom)
```

Read that honestly: the median launch is untouched 800 ms later because the
median launch is spam nobody wants. The one that moved 12.42 SOL is the one worth
having, and that is the one we lose. The gate is what makes losing cheap.

## Next steps

1. ~~Fund the wallet~~ done. ~~Deploy to mainnet~~ done.
2. **A short validation run first.** Helius Sender has never carried a real
   transaction — the fork tests bypass it by design, because it forwards to real
   mainnet. Do `MAX_SNIPES=2 PER_SNIPE_SOL=0.01` before committing the budget,
   and confirm a signature actually lands.
3. Then the real session: 30 min, `GATE_SOL=2`, `MAX_DEV_BUY_SOL` to skip
   launches where the creator bundled a large position.
4. Close the program, reclaim the 0.098 SOL, sweep the wallet, write the post
   from the `run-*.json`.

**Budget note the runner does not track.** `BUDGET_SOL` counts the buy and the
tip, not account rent. Each snipe on a new mint creates a Token-2022 ATA at
~0.002 SOL; the WSOL ATA is created once and reused. Ten snipes therefore lock
roughly 0.02 SOL beyond the stated budget, recoverable by closing the token
accounts afterwards. With 0.15 SOL on hand, ten 0.01 SOL snipes plus tips, fees
and ATA rent comes to about 0.135 — it fits, but not with much room.

If a live run keeps losing, the next lever is the $49/mo Developer plan for
`transactionSubscribe`, not the $499 one — but prove the loss is detection
latency first, because the dry run says it usually isn't.

## Cost

Committed ~0.13 SOL. Recoverable: 0.098 program rent + ~0.02 token-account rent.
At genuine risk: the 0.1 SOL of trading capital, fees, and **0.001 SOL of Sender
tip per landed snipe**. A snipe that loses the race reverts, and a reverted
transaction rolls the tip back with everything else — so tips are only paid on
snipes that land, and a lost race costs the fee alone. The tip instruction is
last for exactly that reason.

Buying is not depositing — a position can go to ~zero in seconds if the dev dumps.

## The post

Hook, verified against On Record's own database:

> **107 programs are deployed to Solana every day. 39 of them — 36.6% — are
> pump.fun snipers.** So I built one.

Also true and checkable: 58.2% of programs deployed *and closed* in a 30-day
window were pump.fun-wired, and the median one lived 29 minutes.

Angle: the honest result is likely "built a working sniper, got beaten to every
launch worth winning anyway." Better than a profit screenshot. Two secondary
finds are exactly what On Record exists to catch:

- a deployed program silently reading accounts its own published IDL doesn't
  document;
- **a fee recipient that rotates with no documented rule**, where mixing two
  individually-valid accounts from different transactions is rejected — and
  where 22 of 25 recent transactions against the program are already failing.
