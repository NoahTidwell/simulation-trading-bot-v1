# simulation_trading_bot_v1

A **simulation-only** Solana memecoin momentum bot. It watches live market data, applies one fixed rule-based breakout strategy, and logs what it *would* have done — with realistic fills, fees, and latency — so the rules can be evaluated before any live build is considered.

> **There is no wallet, no private key, no signing, and no transaction submission anywhere in this codebase.** `SIMULATION_MODE` is hardcoded `true`. The bot needs zero funds to run. `@solana/web3.js` is used for read-only RPC lookups only (`getParsedAccountInfo`, `getTokenLargestAccounts`, `getTokenSupply`). Jupiter is used for `/quote` (read-only) and `/price` only — never `/swap`.

## Quick start

```bash
cp .env.example .env      # add your read-only API keys (Helius at minimum)
npm install
npm start                 # builds and runs; Ctrl+C to stop gracefully
# or: ./scripts/run-simulation.sh
```

Output:

| Path | What |
|---|---|
| `data/trades/trades-YYYY-MM-DD.jsonl` | Append-only trade log, one JSON record per entry / scale-out / exit |
| `data/trades/summary.json` | Running stats, rewritten every scan cycle |
| `data/positions/open-positions.json` | Simulated cash + open positions + closed-trade history (restart recovery) |
| `data/positions/risk-state.json` | Daily P&L, circuit-breaker state (persists across restarts) |
| `data/positions/watchlist.json` | Candidate watchlist with price / tx-count history |
| `data/trades/equity.jsonl` | One equity sample per minute (for the equity curve) |
| `data/positions/event-tail.json` | Last 300 console events (signals, gate results, trades, warnings) |

All of these are gitignored.

## Live dashboard (optional, read-only)

```bash
npm run dashboard         # → http://localhost:4545
```

A separate process that only *reads* the files above and renders them: equity curve, P&L tiles, open positions with hold-time / trailing-stop / tier state, risk & tranche gates, the scanner funnel (why in-band tokens aren't candidates), the event feed, and the full trade log. It refreshes every 4 s, binds to `127.0.0.1` only, and has no dependencies. The bot never talks to it — stop or restart either one independently.

## v1.3 — parallel paper strategy

The bot runs two strategy books side by side in one process: **v1.2** (the main book, `data/`) and **v1.3** (`data/v1.3/`), aimed at ~50 trades/day. Recordings showed v1.2's entry rules produce ~6 pre-gate signals a day — only a couple of tokens in $10–100M trade actively at any time. v1.3 loosens entry only:

| | v1.2 | v1.3 |
|---|---|---|
| Market cap | $10–100M | $1–100M (liquidity floor unchanged) |
| 5m volume floor | A $8k · B $20k | A $4.8k · B $12k |
| Buy:sell | A 1.6 · B 1.5 | 1.2 |
| New 30-min high | required | not required |

Exits, sizing, risk limits and the security gate are identical. The books share the market-data pass, discovery, security verdicts, the recorder and the exit monitor (no extra API calls); each has its own $500 portfolio, risk state, trade log and summary, so both can hold the same token. `V13_ENABLED=off` runs v1.2 alone. Profiles are in `src/config.ts` (`PROFILE_V12`, `PROFILE_V13`); the dashboard switches between them with the v1.2 / v1.3 toggle in the header, and `scripts/replay.ts --book v1.3` replays v1.3's entry rules.

## v1.4 — micro caps (parallel paper strategy)

A third book (`data/v1.4/`, added 2026-09-26) tests whether sub-$1M coins' volatility produces few-but-huge winners that outweigh more frequent losers. Entry is v1.3's logic on a **$100k–$1M** band with a **$15k** liquidity floor and a $3k 5-min volume floor; exits are sized for 30%+ swings: **-25%** hard stop, sell ¼ at **+40%** and ¼ at **+150%**, a **30%** trail (20% past +150%, never below +5%), runners held up to 4 h. Band B is disabled. Each profile now carries its own exit parameters (`StrategyProfile.exit`); v1.2 and v1.3 use `EXIT` unchanged. The watch range was widened to $100k (`WATCH_ONLY_MIN_MARKET_CAP_USD`) and the watchlist to 450 so micro caps are refreshed at full speed. `V14_ENABLED=off` drops the book; the dashboard toggle has a v1.4 tab; `scripts/replay.ts --book v1.4` replays it.

**Caveat:** the simulation always gets an exit fill (at worst a 10% fallback penalty). Real honeypots or pulled liquidity at this size would be -100%, so v1.4's simulated losses are understated. Replays of recordings made before 2026-09-26 05:15 UTC can't judge v1.4 (sub-$1M tokens were then refreshed only once a minute).

## Market recorder + offline replay

The bot records everything it observes that a strategy decision depends on — every DexScreener snapshot it already fetches, every security-gate verdict, every exit-monitor sell quote — to `data/recordings/market-YYYY-MM-DD.jsonl.gz` (no extra API calls; unchanged readings are stored as a short marker; files older than `MARKET_RECORDER_RETENTION_DAYS`, default 60, are deleted at startup; `MARKET_RECORDER=off` disables it).

`scripts/replay.ts` runs those recordings through the bot's own entry filter, sizing, exit rules, ejection triggers, portfolio and risk manager, with any config change, and compares against the unchanged config:

```bash
npx tsx scripts/replay.ts                                   # baseline over all recordings
npx tsx scripts/replay.ts --set EXIT.tiers.1.gainPct=25     # baseline vs one change (several --set = one variant)
npx tsx scripts/replay.ts --variant my-variant.json --trades   # {"name": "...", "set": {"PATH": value}}
npx tsx scripts/replay.ts --from 2026-09-25 --to 2026-09-28 --ungated pass --slip 0.5
```

What the replay can't reproduce: fills are the recorded price 3 s after the decision minus `--slip` % (live uses a Jupiter quote at that moment); prices arrive at the recorded refresh cadence (5 s hot / 15 s warm / 60 s cold, ~1 s for positions the live bot held); a token the live bot never security-gated has no verdict (`--ungated skip` counts them, `pass` assumes they pass), and `SECURITY.*` overrides have no effect; mid-hold security re-checks aren't replayed. The report prints the live bot's trades over the same period as a calibration check.

`scripts/analyze-pump-shape.ts` is a one-off study: it fetches GeckoTerminal minute candles around every closed trade (current book and archives, cached in `data/analysis/`) and tests whether the shape of the 30 minutes before entry (staged, smooth "staircase" pumps) separates winners from losers.

## What it does each cycle (every 5 s)

0. **One market-data pass** — open positions plus every watched token that is due are fetched from DexScreener in a single batched pass. Tokens are tiered by how close they are to the entry thresholds: *hot* (in band, near the volume floor or moving ≥ 1.5%) every cycle, *warm* (in band, quiet) every 15 s, *cold* (out of band / unresolved) every 60 s — all inside the 3-minute history-gap tolerance, so eligibility is unaffected; only reaction latency on quiet tokens changes. Tokens whose best pair is known are refreshed through the `/pairs` endpoint (exactly one pair per address, 30 per call); the `/tokens` endpoint — which silently caps at 30 pairs per response and drops tokens when others have many pools — is used only for new tokens and an hourly best-pair re-resolution, with pair-footprint-aware batching so nothing gets crowded out.
   **Exit monitor (separate 1 s loop).** Open positions are also re-priced from a live Jupiter *sell quote* for the remaining size — about once a second, within a Jupiter budget of `POSITION_MONITOR_QUOTES_PER_MIN` (default 45/min, shared across positions) — and the price rules below run on that price immediately, independent of the scan cycle. The Jupiter Price API is cached 5–10 s behind `/quote`, so before this a stop could act on a ~15 s-old price. A per-position lock keeps the monitor and the scan cycle from acting on the same position at once; on a Jupiter 429 the monitor pauses 15 s and the scan cycle's check remains the backstop. Exit log lines end in `via quote` / `via jupiter` / `via dexscreener`.
1. **Manage open simulated positions** — resolve live prices (Jupiter → DexScreener backup), then in this order:
   - stale price > 60 s → exit at last resolvable price (`stalePrice`)
   - security re-check every 2 min → new danger flag, or 3 consecutive re-check failures → exit (`securityReflag`)
   - 5-min tx count > 5× the token's baseline **while price is going against us** (effective gain < 0, or ≥ 8% below the high since entry) → exit (`velocityEjection`). Baseline = max(trailing 20-min average, tx count at entry): the breakout that triggers an entry is itself a burst, so the trigger looks for a further acceleration *after* entry. A spike on a rising price is left to the trailing stop.
   - hard stop (-12% A / -14% B, effective) → exit (`hardStop`)
   - no follow-through: after 12 min (A) / 20 min (B), if the best effective gain never reached +4% and the position is at or below breakeven → exit (`noFollowThrough`)
   - max hold time (45 min A / 90 min B) → exit (`maxHoldTime`); once the trailing stop is active this no longer applies, only an absolute 240-min cap
   - trailing stop (arms at +12%, trails 15% below the high, 10% once the peak passes +50%, never below +2% effective) → exit (`trailingStop`)
   - scale-outs: sell ⅓ at +12% (`takeProfitTier1`), ⅓ at +35% (`takeProfitTier2`); **there is no final cap** — the last third rides the trailing stop

   Every threshold above uses the **effective gain**: the gain after *estimated exit costs* (fixed fees at the entry-time SOL price, transfer tax, and 1% assumed sell impact), measured against the net entry basis. So a -12% stop realizes ≈ -12% plus any gap during the fill delay, and the +2% trailing floor actually locks in a profit.
2. **Discover candidates** (every 15 min, `DISCOVERY_INTERVAL_MS`) — poll Helius Enhanced Transactions for recent activity on the Raydium AMM v4 / CPMM and PumpSwap programs; every mint seen enters the watchlist. Boosted / promoted / profile lists are **not** used. Each call costs ~100 Helius credits, and entries need 30 min of history anyway, so polling faster buys nothing.
3. **Entry** — for each token that is in a band and passes the entry filter (liquidity, 5-min volume, buy:sell ratio, +3%..+20% 5-min change, 1-h change ≤ +60%, 5-min tx count ≥ 1.5× its own trailing 20-min average, age ≥ 30 min, new 30-min high) and while the risk manager and position sizer allow: run the full security gate (RugCheck + GoPlus + on-chain mint account). If it passes, simulate the entry.
4. Persist state (trade events immediately; the multi-MB watchlist every 90 s, the portfolio every 60 s, the event tail only when it changed), write `summary.json` (which includes per-service API call counts), print a status block to the console.

### Simulated fill mechanics

Every entry and exit:
1. waits a random 2–4 s "execution delay",
2. calls Jupiter `/quote` for the exact size **at that later moment** (real route output / price impact),
3. applies the token's transfer tax (Token-2022 extension, read on-chain), a priority fee, and a Jito tip (`PRIORITY_FEE_SOL`, `JITO_TIP_SOL` in `.env`).

**Fixed fees are currently OFF** (`PRIORITY_FEE_SOL=0`, `JITO_TIP_SOL=0` in `.env`, since 2026-09-26 03:25 UTC) so strategy tuning measures entry/exit quality alone; pool fees and price impact are still in every Jupiter quote. Before that, fills paid 0.001 + 0.0005 SOL (≈ $0.18, 0.6% of a $30 trade). Each trade-log record carries its `priorityFee` / `jitoTip`, so results from either period can be recomputed at any fee level. Restore the fees before judging real-world profitability.

The position's basis and every P&L number already include all of that. Exit rules use the effective gain (net basis on the way in, estimated costs on the way out), so "+12%" means ≈ +12% realized.

**Entry fill sanity check**: if the Jupiter fill deviates more than 10% from the DexScreener reference price, the entry is aborted — the two data sources disagree (stale reference, liquidity pulled mid-signal), and entering on disagreeing data is never allowed. (Added after a rug where DexScreener lagged the collapse by minutes and the bot would have re-bought at a 99.6% "slippage".)

**Re-entry cooldown**: after any exit a token can't be re-entered for 120 min; after a `hardStop`, `velocityEjection`, `securityReflag` or `stalePrice` exit it is excluded for the rest of the UTC day; a token with 2 losing trades in 72 h is blocked for 72 h. Blocks are persisted with the portfolio state.

**Trade quality stats**: every closed trade in `open-positions.json` records `maxGainPct` and `maxAdversePct` — the best and worst effective gain seen while it was open — so exit rules can be tuned against how far trades actually went.

If an **exit** quote is unavailable the position still exits (holding on unresolvable data is never allowed), priced at the last resolvable price minus a 10% penalty and tagged `fillSource: "fallback"` in the log. If an **entry** quote is unavailable the entry is simply skipped.

### Fail-closed rules

Every external call that errors, times out, or returns something unparseable is treated as "unsafe / unknown":
- security gate: any of RPC / RugCheck / GoPlus failing → reject
- holder concentration: GoPlus holders → RugCheck topHolders → on-chain largest accounts; if none provide data → reject
- entry filter: any missing field → reject; insufficient price history → reject
- price feed: returns an explicit `unresolved` state, never a stale number
- SOL/USD unresolvable → no new entries

### Deviations from the original spec (deliberate, config-switchable)

- **Transfer-tax mutability** (`SECURITY.requireImmutableTransferFee`): the spec requires the transfer tax to be fixed and not owner-mutable. It was relaxed to `false` on 2026-09-20 to widen the trade sample (most current Token-2022 launches keep the fee authority, and the rule was rejecting the large majority of momentum signals). **Restored to `true` on 2026-09-21**: over the first 46 trades the tokens the relaxation let through were the worst cohort (25 exits, 1 win, -$60.76, vs 21 exits, 7 wins, -$42.53 for untaxed tokens), and each pays ~3% per side before price moves. The *current* tax is still read on-chain, capped at `SECURITY.maxTransferTaxPct` (10%, lowered to 0% in strategy v1.2), and charged on every simulated fill.
- **Take-profit ladder** (`EXIT.tiers`, changed 2026-09-21): originally 40% at +30%, 30% at +75%, rest on the trail. No position reached +30% in the first 46 trades, so the ladder was lowered to 25% at each of +10 / +15 / +25 and a full exit at +30%.
- **Re-entry cooldown** (`REENTRY.afterAnyExitMinutes`, 60 → 120 on 2026-09-21): PAID was traded 8 times and RAYCAT 5 times inside the first 36 hours for a combined -$27.50.

### Strategy v1.2 (2026-09-23)

v1 closed 55 trades from 2026-09-20 to 09-22 for -$103.82 (-20.5%) with a 21.8% win rate; only 1 of 55 ever reached +10% net, 65% ended at the time limit, stops realized -19.8% against a -15% setting, and the +30% cap meant even a perfect trade averaged ~+20% (break-even needed a ~76% win rate). The bankroll was reset to $500 and the v1 data archived under `data/archive/`. Changes, all in `src/config.ts`:

| Area | v1 | v1.2 | Why |
|---|---|---|---|
| Entry 5m change | +5..+40% | +3..+20%, and 1 h ≤ +60% | enter at the start of the move, don't chase blow-offs |
| Activity signal | — | 5m txs ≥ 1.5× own trailing avg | early-momentum confirmation |
| Volume / buy:sell floors | A $12k / 2.0, B $30k / 1.8 | A $8k / 1.6, B $20k / 1.5 | old floors only cleared late in the burst |
| Scan / refresh | 8 s; warm 24 s; hot at ≥3% | 5 s; warm 15 s; hot at ≥1.5% | faster reaction to breakouts and stops |
| Transfer tax | ≤ 10% (immutable) | 0% only | taxed tokens: 1 win in 26, -$62.25 |
| Profit taking | 25% at +10/+15/+25, all at +30 | ⅓ at +12, ⅓ at +35, rest trails, no cap | let winners run |
| Trailing stop | arms +25%, 20% trail, floor +5% raw | arms +12%, 15% → 10% trail, floor +2% effective | breakeven-plus stop once a third is banked |
| Hard stop | -15 / -20 raw | -12 / -14 effective | realizes near the setting, cuts losers sooner |
| Time exits | 45 / 90 min | + no-follow-through at 12 / 20 min; winners exempt from band limit (240-min cap) | stop paying for drift, keep runners |
| Velocity ejection | any 5× spike | only with adverse price | a spike on a rising price is the goal |
| Repeat losers | 120-min cooldown | + 2 losses in 72 h → 72 h block | PAID: 10 trades, -$13.43 |
| Position size | 4% of bankroll | 6% | same ≈0.8% risk per trade at the tighter stop; fixed fees 1.9% → 1.3% of size |

### Risk manager

- **Daily loss limit**: realized P&L for the UTC day ≤ -15% of that day's starting bankroll → no new entries until the next UTC day.
- **Drawdown circuit breaker**: equity ≤ -30% vs the starting bankroll → all new entries halt, logged loudly, persisted, **never auto-resumes**. To resume after review, delete `data/positions/risk-state.json` and restart.
- **Tranche gates**: reporting only (`summary.json → trancheGates`), shows which gates the track record would satisfy.

Position sizing (6% of bankroll, max 7 concurrent, max 60% exposure) lives in exactly one place: `src/strategy/position-sizer.ts`.

## Configuration

Every strategy constant is in [`src/config.ts`](src/config.ts). `.env` holds only API keys and a few simulation parameters (starting bankroll, fee estimates, seed mints, log level). See `.env.example`.

`WATCHLIST_MINTS` lets you seed specific tokens for pipeline testing — they still have to pass every gate and filter.

## Trade log schema

One JSON object per line:

```
timestamp, tokenAddress, symbol, band, eventType ("entry"|"scaleout"|"exit"),
quotedPrice, netFillPrice, sizeUsd, sizeSol, transferTax (USD), priorityFee (SOL), jitoTip (SOL),
slippageRealizedPct, exitReason (null for entries), realizedPnlUsd, realizedPnlPct, simulated: true,
positionId, fillSource ("jupiterQuote"|"fallback"), executionDelayMs
```

The last three are diagnostics beyond the required schema.

## Layout

```
src/
  index.ts                 main loop, graceful SIGINT/SIGTERM shutdown
  config.ts                all strategy constants, endpoints, paths
  types.ts
  data/                    candidate-scanner, dexscreener-client, jupiter-quote-client, price-feed
  security/                rugcheck-client, goplus-client, security-gate (+ on-chain mint checks)
  strategy/                bands, entry-filter, exit-rules, ejection-triggers, position-sizer
  simulation/              simulated-execution, cost-model, portfolio
  risk/                    risk-manager
  logging/                 trade-logger, console-reporter
  utils/                   sleep, format, http
```

## Notes / known limits

- **Helius is required for discovery.** Without `HELIUS_API_KEY` the bot runs, but only `WATCHLIST_MINTS` seeds are evaluated, and on-chain holder lookups on the public RPC are heavily rate-limited (they then fail closed).
- Third-party API shapes drift. Each client parses defensively and fails closed, but if RugCheck / GoPlus / DexScreener / Jupiter change a response format you'll see it as a rise in `gate REJECT` / `unresolved` lines rather than a crash.
- The entry filter needs ≥ 30 minutes of observed price history per token (for the "new 30-min high" check), so the first entries appear no sooner than ~30 minutes after a token first hits the watchlist.
- Not built, on purpose: live execution, wallets, dashboards, databases, social/sentiment inputs, multiple strategies.
