# pumpsnipe

A pump.fun launch sniper in ~180 lines of Pinocchio, built to be documented
rather than to make money.

**13,976 bytes. 0.098 SOL of deploy rent, refundable when you close it.**
The same program in Anchor was 192,560 bytes and 1.34 SOL.

## What the program does

One thing a client-side buy cannot: it re-reads the bonding curve **at
execution time** and refuses the trade if the curve has already moved past a
bound you set. A sniper that loses the race would otherwise still land and buy
the top. This one reverts, and you pay the transaction fee instead of the price.

Everything else is forwarded verbatim — the accounts and pump.fun's own
instruction data pass straight through. That matters: pump.fun changed its buy
account list twice while this was being written and its published IDL documents
neither change. Because the program doesn't know what it's wrapping, it works
against `buy`, `buy_v2`, `buy_exact_quote_in_v2` or whatever ships next without
a rebuild.

```
instruction data
  [0]      curve_index                u8   where the bonding curve sits
  [1..9]   max_virtual_quote_reserves u64  the gate
  [9..]    pump.fun's own instruction data, untouched
```

## Layout

```
src/lib.rs        the program
client/lift.mjs   derives pump.fun's 27 v2 accounts from a mint
client/snipe.mjs  fires one snipe
client/watch.mjs  the detector — watches launches and fires at what passes
```

## Build

```bash
cargo build-sbf --tools-version v1.52
```

The `--tools-version` is not optional. The default platform-tools ships rustc
1.84; Pinocchio 0.11 needs 1.89, and without the flag the build either fails to
resolve or silently hands back a stale artifact.

## Test against a mainnet fork

```bash
SURFPOOL_DATASOURCE_RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
  surfpool start --no-tui --no-deploy
```

Then, in another shell:

```bash
solana program deploy target/deploy/pumpsnipe.so \
  --program-id target/deploy/pumpsnipe-keypair.json --url http://127.0.0.1:8899
```

Fire one snipe at a live mint. The gate defaults to the curve's current level,
which always passes:

```bash
node client/snipe.mjs <mint> 0.05
```

Force the losing path by setting the gate below the curve:

```bash
node client/snipe.mjs <mint> 0.05 1     # → custom program error: 0x7, LOST_THE_RACE
```

## Run it for real

Deploy with `--max-len` pinned to the binary size so you pay 0.098 SOL of rent
instead of double that for upgrade headroom:

```bash
solana program deploy target/deploy/pumpsnipe.so \
  --program-id target/deploy/pumpsnipe-keypair.json \
  --max-len 13976 \
  --url mainnet-beta
```

Then run the detector with a hard budget:

```bash
RPC_URL=https://mainnet.helius-rpc.com/?api-key=$KEY \
WS_URL=wss://mainnet.helius-rpc.com/?api-key=$KEY \
BUDGET_SOL=0.1 PER_SNIPE_SOL=0.01 MAX_SNIPES=10 RUN_MINUTES=30 \
  node client/watch.mjs
```

It stops on whichever limit trips first and writes a `run-*.json` with every
launch seen, every snipe fired, what landed and what it cost.

When you're done, close the program and take the rent back:

```bash
solana program close <PROGRAM_ID> --bypass-warning --url mainnet-beta
```

## What to expect

You will lose the races. Competitive sniping is Jito bundles and validator
co-location, and a good share of what looks like sniping is the launcher buying
their own token inside the same atomic bundle as the create — there is no gap
to get into. The realistic aim is to be the first *second* buyer.

The gate is what makes losing cheap: a lost race costs a transaction fee rather
than a bad fill.

## Errors

| code | meaning |
|---|---|
| 1 | instruction data too short |
| 2 | account count outside 16–32 |
| 3 | bonding curve not owned by pump.fun |
| 4 | bonding curve account too small |
| 5 | wrong account discriminator |
| 6 | curve already graduated |
| **7** | **lost the race — curve moved past the gate** |
| 8 | curve has no tokens left |
| 9 | pump.fun not among the accounts |
| 10 | curve index out of range |
