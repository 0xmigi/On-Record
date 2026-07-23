# Gator — draft post

**Program:** `gatorLx9aC1e5ZWAXscv5QRKiLXnLPLXjftVc81h1Hr`
**Status:** unposted draft
**Researched:** 2026-07-22/23

---

## Draft

found another one. no name, no site, no repo, no idl.

`gatorLx9aC1e5ZWAXscv5QRKiLXnLPLXjftVc81h1Hr`

deployed june 30. 2,176 transactions a day, which looked like a lot until i
noticed they're all the same transaction — one every 39.7 seconds, like a
metronome.

every single one is byte-identical in shape. 1,011 bytes of payload, exactly
three accounts, always the same target account, and a read of the clock.

the payload is 62 numbers in i80f48 — 128-bit fixed point, 48 bits of
fraction. that's not a format you pick for prices. it's the format you pick
when you're going to do polynomial math and can't afford to lose precision.

62 numbers is also far too few to be quotes for the 1,704 pools it tracks
across orca, meteora, raydium and pumpswap.

so it isn't publishing prices. there's a file in the binary called spline.rs,
and a cubic spline with ~15 knots takes about 60 coefficients. it looks like
it's fitting a curve off-chain and publishing the fitted curve on-chain,
every 40 seconds, so the program can evaluate it cheaply at swap time.

next to spline.rs is toxicity_model.rs, router.rs, and an adapter for each of
the five amms.

toxic flow is the market-maker's term for informed traders picking you off.
this is a router that would price its spread against how toxic your order
looks.

it has never done it. the swap path fired 7 times out of 200 transactions.

so: someone has a live model publishing to solana every 40 seconds, 2.1 mb a
day, and the trading engine that consumes it is dark.

written in pinocchio at 362kb — 11x the median for that framework, top 7%.
imports sol_curve_multiscalar_mul, which 2 of 2,412 mainnet programs use.

none of this is published anywhere. it's all read out of the binary — the
crate names leak through rust panic paths, and the rest is transaction shape.

---

## Verified facts

| claim | value | method |
|---|---|---|
| First deploy | 2026-06-30 | ProgramData |
| Cadence | one write / 39.7s | 24h signature walk |
| Volume | 2,176 txns/day | 24h walk, 1.2% failed |
| Payload | 1,011 B, first byte 0x00, 3 accounts | 58/58 sampled across 24h |
| Write target | `8G8VMQ23BDQELMmHcKAitfg4sPTnZzTsY3tAMLkP69Zf` | 58/58 identical |
| Records | 62 × 16-byte i80f48 + 3 B | (1011−16)/16 |
| Throughput | 2.10 MB/day | 1011 B × 2176 |
| Byte churn | 42.9% between consecutive writes | diff |
| Reference pools | 1,704 × 512-byte accounts | getProgramAccounts |
| Big store | 752,976 B, 5.24 SOL rent, untouched by loop | getProgramAccounts |
| Swap usage | 7 / 200 txns touch any AMM | Helius parse |
| Size rank | 362 KB = 11× pinocchio median, top 7% of 830 | corpus |
| Rare primitive | `sol_curve_multiscalar_mul`, 2 of 2,412 | corpus |
| Authority | `7juwu8KF…` hot wallet, 93.5% of all txns | 24h sample |

## Inferences — label as such if used

- **Spline coefficients, not prices.** From record count (62) + `spline.rs` +
  i80f48 precision + 40s cadence. Strong but not proven.
- **Market-making / dynamic spread.** 40s ≈ 100 slots rules out HFT and perps
  marks; no lending or perp modules present.

## Known-wrong things to avoid repeating

- NOT double-buffered — all writes go to one account (I claimed otherwise once)
- NOT maintaining the 1,704 pool accounts — the loop never touches them
- NOT the same team as `amm` (`ZERor4xh…`) — TLSH distance 261, different
  authority, 18 months apart
- No 真 anywhere. That was a typo in my own text, not a finding.
