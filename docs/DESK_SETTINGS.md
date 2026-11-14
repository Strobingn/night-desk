# Night Desk settings

Last updated: 2026-11-14 (13.57). Dirk set the live daily cap to $500. Other live prefs and rules are still the 1:46 PM ET pull. No new Oracle pull.

These files (`docs/DESK_SETTINGS.md` and `docs/desk-settings.json`) are the canonical, repo-readable snapshot of how the production desk is wired and what it is set to. Prefs and rules were pulled from the live Oracle host (`/api/state`, `/api/health`, `/api/wallet`, `/api/live/ready`, `/api/orders`) at 1:46 PM ET, while that host was still **13.29** (`02ba1c0f0adc21460a20801854e1c9fe79fcf1fd`). **13.30** added the trading engine, its code settings, `/api/strategy/*`, and the phone's Oracle fallback (`https://night-desk.157-151-200-171.sslip.io`, ahead of the old trycloudflare default). **13.32** adds a manual override: an explicit paper or live buy (Home, Tape, Search, Details, Pump Watch) fills even when the engine is only watching (`SIGNAL_WATCH`), the analyst score is under the line, a soft filter killed the coin, or a hard-stop ban is still counting. A hard kill still shows Buy anyway, then fills, including live. The engine and AI stay paper-only. No new Oracle pull; prefs stay the 1:46 PM ET numbers. **13.33** keeps those limits and stops the desk from going quiet when the equity table or the Helius lane is busy. `/api/state` equity is at most 240 points, bucketed in SQL (first and last of the range, and the minimum and maximum equity in each time bucket) and cached until the next insert. `equity(ts)` stays indexed. `GET /api/orders` returns the order list without building that snapshot. `GET /api/settings` returns the settings object instead of the SPA HTML. `GET /api/wallet` returns the cached SOL/USDC balance, `balanceAgeMs`, and `balanceStale`, and refreshes in the background. A live buy still checks the wallet, waits at most 4 seconds, then uses a successful cache from the last 60 seconds or refuses. The $5 and $20 checks still run on those figures. The Helius priority-0 queue drops a stale duplicate mint and drops the oldest mark past 24 waiting. Caps stay 10 read + 8 exec. `/api/health` adds `eventLoopLag` (p50, p99, max milliseconds). The phone still polls `/api/state` every 3 seconds. A slow `/api/wallet` poll does not set the Home "Desk is slow" banner when state is answering. **13.31** brings Claude's tip `8b3fe9484c12e41efded821e223891907c3051d6` onto that release. The engine code matches the patches already in 13.30 (through `9f6bd0d`); the new commit is his desk-settings note. Those engine numbers are the code in `src/strategy/config.ts`, not a second live pull. The author of `8b3fe94` had no desk token, so `/api/strategy/*` was not re-pulled and must be pulled after deploy. Oracle does not serve the engine until this release is deployed.

**Every Night Desk release must update both files in the same PR.** Re-pull live settings, and add any new endpoints, env names, or controls the release introduces. Never put token values, private keys, or RPC URLs that carry an API key (path or query) in this repo. Hostnames only. A wallet pubkey is fine.

Machine-readable copy: [`docs/desk-settings.json`](desk-settings.json).

## Hard rules

- AI stays paper-only. `liveAutoBuy` cannot be turned on. `POST /api/settings` with `liveAutoBuy: true` is refused. Live scope is manual: an operator buy, limit, or stop may send a real swap; AI auto-buys never spend live. The trading engine is paper only by default. Since 13.40 the owner can set one engine variant live (`liveVariant` on `POST /api/strategy/settings`, the Engine tab's Live money section). That is the only AI path that can spend live, it is off until set, and any other AI live buy is still refused with `LIVE_AI_BLOCKED`.
- The desk's hard stop is checked before an engine exit. A mark at or past the hard stop closes as `STOP_LOSS` or `GAP_RUG`, not as the engine's own stop. The engine's stop (1% on the main paper book) can only be tighter.
- Never drop the v13.11 baseline controls (paper and live limit / take-profit / stop orders, and the rest of that book and ticket UI).
- Bogus-price rejection stays on (`src/market/mark-guard.ts`). Non-finite or non-positive prints are rejected. Implausible upward jumps and unit / decimal or SOL-vs-USD mix-ups (including a rise of 25× or more) do not update equity or stops unless confirmed. A genuine crash is never rejected by this guard, so the hard stop can still fire.
- The hard stop cannot be loosened past 6%. `LIVE_TRADING`, the wallet secret, and mode cannot be changed from the API.
- 13.40: twelve trailing shadow books and the opt-in engine live variant. See "13.40 notes". The hard stop, the Helius 10/8 caps and the live $5 / $20 limits are unchanged.
- 13.30: the trading engine trades the paper book only (until a live variant is set, 13.40). Its buys go through the analyst path, which refuses the live book. The engine stop can only sit tighter than the hard stop and never moves it. The scorecard `ready` flag arms nothing.
- 13.31 keeps that engine. It does not add a live order path, move the hard stop, change the Helius 10/8 caps, or change the live $5 / $20 limits.
- 13.32: an explicit manual buy (`POST /api/positions/buy`, source `manual`, book `paper` or `live`) bypasses the engine watch, the analyst score, soft filter kills, and the hard-stop ban. A resting limit fill uses the same buy checks but does not skip the ban. The desk logs `MANUAL_OVERRIDE` and can return a `warning`; the fill already happened. Hard kills (`MINT_AUTHORITY_ACTIVE`, `DEV_RUG_HISTORY`, token safety `blocked`) still return `HARD_KILL` until `confirmHardKill`. That confirm may be live. Analyst and engine buys still cannot name the live book (`LIVE_AI_BLOCKED`). This does not change the $5 default, the $20 daily cap, the wallet check, entry slippage, pool depth, idempotency, operator auth, or bogus-price rejection.
- 13.33: the poll path no longer loads the whole equity table or waits on Helius for `/api/wallet`. The equity cache keeps time buckets (first, last, min, max) and widens them as the session grows, so a later insert does not resample the 240-point cap. Snapshots carry a monotonic `seq`; the phone and the web UI ignore an older one, and a position mark drops the 1s cache. A live buy still refuses a balance older than 60s. A live sell may use an older successful SOL figure so a stop is not stuck behind Helius. Caps stay 10 and 8. Live size stays $5, the daily cap $20, exit slippage 6%, cooldown 0, and the engine $10 UTC-day paper-loss pause. The engine stays paper-only. The 13.32 manual override is unchanged. No numeric trading or filter setting moved.
- 13.35: phone redesign only. Five tabs (Home, Tape, Search, Engine, Settings). Home leads with equity and today's result. Tape folds the LIVE strip behind one line. The Engine tab holds the trading engine switch, sizing, scorecard, and pipeline timings. Settings has a filter box, More rows (Link, Recap, Pump terminal), compact sliders, and a pinned Save bar. `strategy.mainOpen` counts engine positions on the main paper book. No desk setting, limit, or trading behavior changed. Landed on main as `bfd761a` (PR 36).
- 13.39: a live sell that gets Jupiter NO_ROUTES_FOUND, a drained quote side, or an exit above the 6% cap answers in a few seconds with a clear reason. Phone live sells use the 45s live client and show that reason instead of "timeout". When the pool's quote-side liquidity is drained, or Jupiter has no sell route, the holding card stops treating the stale DexScreener mid as sellable value, shows "Liquidity gone, no sell route", and books residual (often ~$0) into equity and P&L so a bogus mid cannot inflate them. A real crash that still has quote-side liquidity still marks and can fire the hard stop. The live position stays open; a later sell can retry if a route returns. There is no Sell anyway over 6%, and exit slippage stays 6%. No numeric setting changed. Caps stay 10 and 8. Live size stays $5, the daily cap $20, cooldown 0. Engine and AI stay paper-only.
- 13.38: a manual paper or live buy no longer waits for an uncapped Helius launch-bundle check. The check stays warning-only and uses the existing 1.5s `launchBundleSoon` budget. An unenriched pump coin still quotes under the same caps (Jupiter and the bonding-curve read), and `ensureDepth`'s curve read uses that 1.5s budget, so a saturated Helius lane cannot hold the phone past its 12s paper timer (or the 45s live timer). The 13.32 manual override is unchanged: the buy still goes through when the coin is not enriched, with Buy anyway on a hard kill. No numeric setting changed. Caps stay 10 and 8. Live size stays $5, the daily cap $20, exit slippage 6%, cooldown 0. Engine and AI stay paper-only.
- 13.37: Meteora DAMM v2 is not a traditional LP. A pool with no LP token (RugCheck's `11111111…` mint, or a `damm v2` market) is not an unlock, same as DLMM. When a traditional pool reports reserve depth (`baseUSD` + `quoteUSD`, or DexScreener `liquidity.usd`), the lock is judged on the deepest of those pools. A pool with no figures does not fail the coin when another pool has depth or a real lock. The 95% line and `allowUnlockedLp` are unchanged. A `getTokenLargestAccounts` page is not a holder total: a short page stays unknown, and RugCheck `totalHolders` is the count when the report has one. A missing count still fails closed when a holder minimum is set. No numeric setting changed. Hard kills are not loosened.
- 13.36: Search lookup no longer wraps the whole chain read in a 2s wall that RugCheck can eat. Alchemy `getAccountInfo` starts immediately, holder reads and RugCheck run beside it, and the budget is whatever is left inside the phone lookup client's 8s timeout after the price read, leaving room for the response. Safety and the bundle check run during that read. Reusing a sighting does not refresh the age of the fields it copied. Fields that landed are kept. A chain timeout reuses a successful enrich of the same mint from the last 30 minutes. LP lock is judged on the deepest traditional pool; Meteora DLMM and other concentrated-liquidity pools are not an unlock. Lookup and manual-buy lines in `desk.log` include `chainTimedOut`, the providers that answered, and the checks. `/api/health` and `pipeline.unverifiedKills` count fail-closed "could not be verified" kills by code. The hard stop is measured from the entry mark, not the slipped fill, so paying entry slippage is not itself a stop. Stop percent, trail, exit slippage 6%, cooldown 0, Helius 10+8, live $5/$20, bogus-price rejection, the engine paper book, and the 13.32 manual override are unchanged. No new Oracle pull.
- 13.34: a free-feed pre-filter runs before any Helius or Alchemy read. It uses the existing volume, liquidity, and age settings (no number changed; there is no configured market-cap floor or ceiling). A hard kill is not enriched again. A soft kill such as `VOLUME_TOO_LOW` gets one recheck after 5 minutes, and only if a later free print shows volume above the floor. Search and manual buys still call RPC for a mint the pre-filter killed. Chain marks are kept for held coins and the watchlist. Helius caps stay 10 and 8. Rebased onto main after PR 33 (`08233e1`, which includes `5cca6d92`).
- Leave live trade size at $5 and the daily cap at $500, exit slippage at 6%, cooldown at 0, and the Helius lane caps (10 read + 8 exec, combined `reqLastMin` never above 18) unless Dirk approves a change. The cap's allowed band is still $1–$100,000.

## Pre-filter (13.34)

Scout still publishes a Tape row immediately. Before `enrichSighting` calls Helius or Alchemy it applies the saved floors that do not need chain data: 1h volume, liquidity (when the floor is above 0), age window (when set), ban list, junk symbol or name, unusable or unit-scaled price, and a mint already killed. Market cap is carried on the free payload and shown on the Tape. The desk has no mcap floor or ceiling, so none was added.

A missing volume or liquidity waits for one later free-feed print (DexScreener, Gecko, Jupiter, or the Pump stream). It does not spend an RPC read to learn that number.

Today, a coin that reaches enrich costs, on the RPC host: `getAccountInfo`, `getTokenLargestAccounts`, and `getMultipleAccounts` (3 reads). Helius DAS `getTokenAccounts` pages are extra and only when `holderPagesMax` is set. RugCheck is a separate HTTP call and only after volume already clears the floor. A soft recheck used to run that enrich again (the queue holds 300). Priority-0 chain marks (`getMultipleAccounts`) also ran for Tape curves and pump sightings with no price, which is what pinned the 10/min read lane. Wallet reads stay priority -1. Manual Search and buy pre-checks now use that same priority so they jump ahead of marks. Held positions and the watchlist keep their chain marks.

A cooldown ban is checked on each print and is not stored as a permanent kill, so clearing the cooldown (it is 0 in production) lets the mint through again. Chain marks stay for held coins, the watchlist, and an open limit buy.

`/api/state` and `/api/health` include `prefilter`: kill counts by reason, `rpcSaved`, Helius priority-0 depth, and enrich p50/p90. The phone Settings screen adds one line for that. No control was removed.

## Backend

| | |
|---|---|
| Public base URL | `https://night-desk.157-151-200-171.sslip.io` |
| TLS | Caddy listens on **443**, issues a Let's Encrypt certificate (ACME, HTTP-01 disabled). There is no :80 listener, and HTTP redirects are disabled. |
| Desk process | `night-desk` on **loopback 127.0.0.1:4721** (`HOST=127.0.0.1`, `PORT=4721`) |
| Caddy site | `https://night-desk.157-151-200-171.sslip.io` → `reverse_proxy 127.0.0.1:4721` |
| WebSocket | `wss://night-desk.157-151-200-171.sslip.io/ws` (same auth) |

The backend is this Oracle host, not the Austin desktop. Android `candidateUrls` keeps the saved Link-tab URL first, then the last good URL, a trycloudflare `publicUrl` from `/api/health`, and the Supabase beacon. The next fixed fallback is `https://night-desk.157-151-200-171.sslip.io` (`ORACLE_DESK_URL` in `DeskRepository.kt`). `DeskBeacon.DEFAULT_PUBLIC_URL` (the old Austin `trycloudflare.com` tunnel) stays last. If nothing is saved and nothing answers a probe, the phone holds the Oracle URL.

## Authentication

When `DESK_TOKEN` is set (it is, in production), every page, `/api/*`, and `/ws` requires a match. When it is empty, the gate stays open (local-open only).

**Header (preferred):** `X-Desk-Token: <token>`

**Also accepted:** query `?token=<token>`, or HttpOnly cookie `desk_token` (`Path=/; SameSite=Lax; Max-Age=2592000`). The server sets that cookie on every authorized response.

**Token format:** an opaque shared secret from the `DESK_TOKEN` env var — any non-empty trimmed UTF-8 string. It is not a JWT, and `Authorization: Bearer` is **not** accepted. The desk hashes both sides with SHA-256 and compares with timing-safe equality. A miss is `401` with `WWW-Authenticate: DeskToken` and body `Unauthorized`.

**The token value is secret, not in this repo, and must never be logged or committed.**

### Android

The operator pastes the token on the Link screen (preference key `desk_token`). Every HTTP call sends header `X-Desk-Token` and also appends a URL-encoded `?token=` (or `&token=`). The WebSocket opens `wss://<host>/ws?token=` and also sets the header.

### Web

A first visit may carry `?token=`. The page copies it into `sessionStorage` key `night-desk-token` and strips it from the address bar. Later `fetch` calls send header `X-Desk-Token` and also set the query param. The session cookie covers a plain browser reload.

## API the clients use

`GET /api/settings` is **not** a JSON route; it falls through to the web app HTML. Clients **read** settings from `GET /api/state` (`prefs` and `rules`) and **write** them with `POST /api/settings`. The desk persists that object in SQLite KV key `settings` at `DB_PATH` (`/var/lib/night-desk/desk.sqlite`).

| Method | Path | Key response fields |
|---|---|---|
| GET | `/api/health` | `ok`, `mode`, `now`, `publicUrl` (null on the Caddy host), `eventLoopLag`, `prefilter` (`kills`, `rpcSaved`, `heliusQueue`, `enrich.p50Ms`, `enrich.p90Ms`), `unverifiedKills` (fail-closed "could not be verified" counts by reason code) |
| GET | `/api/state` | `seq`, `appVersion`, `mode`, `liveScope`, `liveBook`, `wallet`, `readiness`, `cashUsd`, `equityUsd`, `startingBalanceUsd`, `sessionPnlUsd`, `prefs`, `rules`, `positions`, `closed`, `orders`, `feed`, `pipeline`, `killReasons`, `recheck`, `enrich`, `prefilter`, `events`, `advice`, `watchlist`, `exposureUsd`, `positionCapUsd`, `cooldowns`, `rawTape`, `tapeQuotes`, `markLoop`, `safetyChips`, `lastClientCrash`, `strategy`, `perf`, `now` |
| GET | `/api/strategy/scorecard` | `ok`, `strategy` (same scorecard as `state.strategy`): engine settings, watch count, eighteen shadow-book rows (six fixed-target, twelve trailing: `trailPct`, `fade`, `live`, `trades`, `wins`, `winRate`, `avgWinUsd`, `avgLossUsd`, `netUsd`, `avgNetUsd`, `maxDrawdownUsd`, `open`, `active`, `ready`), `liveVariant`, `live` (`open`, `tradeUsd`, `targetNetUsd`, `blocked`), `stats`, `note`. |
| POST | `/api/strategy/settings` | `ok`, `strategy`, `error`. Body may set `enabled`, `tradeUsd` ($5–$500), `targetNetUsd` ($0.25–$50), `maxOpen` (1–6), and `active` (`{launch, momentum}` variant ids: `launch-1`, `launch-3`, `launch-6`, `momentum-1`, `momentum-3`, `momentum-6`). Saved in SQLite KV key `strategy`. Cannot arm live. |
| POST | `/api/strategy/reset` | Requires `confirm: true`. Wipes the shadow books and `shadow_trades`. The main paper book is not touched. |
| GET | `/api/events` | `events` (query: `limit`, `stage`, `before`) |
| POST | `/api/settings` | `ok`, `settings`, `error`. Body is a partial object of allowed keys only. `liveAutoBuy: true` is refused. Wallet secrets, `LIVE_TRADING`, and `mode` are blocked. |
| POST | `/api/positions/buy` | `ok`, `error`, `code`, `ms`, `replayed`. Body: `mint`, optional `sizeUsd`, `book`, `idemKey`, confirm flags. On an armed desk the client must name `book` (`paper` or `live`); omitted is refused, not live. |
| POST | `/api/positions/sell` (alias `/api/positions/close`) | `ok`, `error`, `ms`. Body: `mint`, optional `fraction`/`percent` (25/50/100 or 0.25/0.5/1; omitted = 100%), `book`, `idemKey`. |
| POST | `/api/positions/sell-all` | Requires `{"confirm": true}`. |
| GET | `/api/orders` | `ok`, `orders` (v13.11 limit / take-profit / stop, paper and live) |
| POST | `/api/orders` | `ok`, `order`, `error`, `replayed` |
| POST | `/api/orders/cancel` | `ok`, `error` (404 if missing). Body: `id`. |
| GET | `/api/wallet` | `keyLoaded`, `publicKey`, `solBalance`, `usdcBalance`, `solPriceUsd`, `live`, `liveScope`, `liveAutoBuy`, `liveTradeUsd`, `liveDailyCapUsd`, `liveTrailPct`, `liveSpentTodayUsd`, `balanceError`, `minFeeSol`. Never the private key. |
| GET | `/api/live/ready` | `mode`, `liveTradingFlag`, `keypairPresent`, `walletPublicKey`, `rpcPresent`, `operatorReady`, `liveScope`, `lines` |
| POST | `/api/live/ready` | Only `{"operatorReady": true}` or `{"operatorReady": false}`. Cannot set `LIVE_TRADING` or a key. |
| POST | `/api/paper/reset` | `ok`, `cashUsd`, `startingBalanceUsd`, `archive`. Requires `confirm: true`. Paper book only. |
| GET | `/api/lookup` | Query `q`. 200 also for `AMBIGUOUS`; 422 for `PRICE_UNAVAILABLE`. |
| GET/POST | `/api/watchlist` | POST body `q`. Remove: `POST /api/watchlist/remove` or `DELETE /api/watchlist` with `mint`. |
| GET | `/api/recap` | Query `since`: `12h`, `24h`, `7d`, or `reset`. |
| POST | `/api/client-crash` and `/api/client-crash/dismiss` | Phone crash card. |
| * | `/api/pump/*` | Pump terminal, journal, portfolio, sniper, alerts. Same auth. |
| WS | `/ws` | Coalesced snapshots and mark deltas. Same auth. |

Allowed `POST /api/settings` keys: `liveTradeUsd`, `liveDailyCapUsd`, `liveTrailPct`, `positionRefreshMs`, `minVolume1hUsd`, `analystMinScore`, `volumeBoost`, `maxTop10Pct`, `maxPositionPct`, `defaultBuyUsd`, `maxOpenPositions`, `allowUnlockedLp`, `maxEntrySlippage`, `maxExitSlippage`, `minLiquidityUsd`, `minTokenAgeMin`, `maxTokenAgeMin`, `minHolderCount`, `maxDevHoldingPct`, `maxTradesPerHour`, `dailyMaxLossUsd`, `cooldownHours`, `stopLossPct`, `trailTakeProfit`, `trailArmPct`, `trailGapPct`, `autoBuy`, `scoutDexscreener`, `scoutGecko`, `scoutJupiter`, `scoutDexpaprika`, `scoutBitquery`, `scoutPumpApi`, `scoutLaunchLab`, `notifyNearMiss`, `notifyFills`, `notifyStops`, `pnlAlertPct`, `positionSizeUsd`, `maxExposurePct`, `paperResetUsd`, `senderTipSol`.

`scoutPump` is display-only and always on.

## Trading engine (13.31, same behavior as 13.30)

On for a live feed. `strategyEngine` defaults on when `FEED_MODE=live` and the demo tape is off. Production has `FEED_MODE=live` and `DEMO_FEED=0`, and it does not set `STRATEGY_ENGINE`, so a 13.31 boot turns the engine on. `STRATEGY_ENGINE=0` would turn that default off. A saved Settings → Trading engine switch (SQLite key `strategy`) wins after boot. Dirk approved leaving that default-on logic as it is, including the $10 UTC-day paper-loss pause.

The $10 pause is a code constant (`STRATEGY.dailyMaxLossUsd` in `src/strategy/config.ts`). It is not a `POST /api/strategy/settings` field. New paper engine buys stop for the rest of the UTC day once today's paper result is $10 down. The paper-loss pause applies to paper only and does not stop a live engine buy. Shadow books use the same pause on their own results. It does not change the live $5 / $20 caps.

| Setting | Value | Where |
|---|---|---|
| Engine | on (live-feed default) | `enabled`, boot from `strategyEngine` |
| Paper size | $50 | `tradeUsd` |
| Open at once | 2 | `maxOpen` |
| Take-profit | $3 net of modeled fees and slippage | `targetNetUsd` |
| Main-book stop | 1% (`launch-1`, `momentum-1`) | `active` |
| Daily paper-loss pause | $10 | `STRATEGY.dailyMaxLossUsd` (not a settings key) |
| Launch | under 30 min, +2% over 3 quotes spanning 20s, 5m volume 1.5× hourly pace, 10 min time limit | `STRATEGY.launch` |
| Momentum | 30 min or older, +3% inside 5 min (90s of history), same volume pace, 1h change positive, 30 min time limit | `STRATEGY.momentum` |
| Breakeven | arms at half the $3 target | `STRATEGY.breakevenAt` 0.5 |
| Re-entry | 30 min | `STRATEGY.reentryMs` |
| Watch list | 12 coins, 30 min | `STRATEGY.watch` |
| Shadow books | Launch and Momentum at 1%, 3%, and 6% stops. Each starts at $100. Paper fills only. Ready at 200 trades with a net profit, which does not arm live. | `VARIANTS` |

With the engine on, a coin that passes Filter and Analyst is watched instead of bought on sight. A signal opens a paper position. The −6% hard stop (tighter if settings say so; production is 2.5%) is checked first.

## Current settings

Pulled 2026-11-11 1:46 PM ET (prefs / rules on `/api/state`). Percents are shown as the operator sees them; the desk stores many of them as fractions.

### Filters (8:22 PM ET tuning, plus the approved 10% max-dev line)

| Setting | Current | Stored as |
|---|---|---|
| 1h volume | $5,000 | `rules.minVolume1hUsd` 5000 |
| Min liquidity | $4,000 | `prefs.minLiquidityUsd` 4000 |
| Min holders | 15 | `prefs.minHolderCount` 15 (UI cap 20 while enrich is off Helius) |
| Top 10 cap | 30% | `rules.maxTop10Pct` 0.3 |
| Max dev holding | 10% | `prefs.maxDevHoldingPct` 0.1 |
| Min / max age | off / no max | `minTokenAgeMin` 0, `maxTokenAgeMin` 0 |
| Allow unlocked LP | off | `prefs.allowUnlockedLp` false |

13.29 filter behavior: when enrich only sees the top 20 holders (Alchemy today, `HOLDER_PAGES_MAX=0`), a full list of 20 counts as 20 or more. Dev share is computed from those top-20 holders; pool vaults are excluded; any share over 100% fails closed. Coins that miss only the soft filters get one recheck (`/api/state.recheck`: `pending`, `ran`, `dropped`).

### Analyst

| Setting | Current |
|---|---|
| Trade line | **0.35** (`rules.analystMinScore`) |
| Volume boost | 50% (`rules.volumeBoost` 0.5) |

### Paper sizing and auto-buy

| Setting | Current |
|---|---|
| Auto-buy (paper) | **on** |
| Live auto-buy | **off, locked** |
| Manual buy $ | $5 |
| Fixed position $ | null (use the % cap) |
| Position cap | 29.5% |
| Max total exposure | 70% |
| Max open | 20 |
| Max trades / hour | 34 |
| Daily max loss $ | 0 (off) |
| Paper reset $ | $100 |
| Position price refresh | 1 s |

### Trading engine defaults (13.31)

Stored in SQLite KV key `strategy`, not in `prefs`. Code defaults below; re-pull after deploy.

| Setting | Default | Notes |
|---|---|---|
| Engine | **on** for live feeds | `FEED_MODE=live` and `DEMO_FEED=0` on this host, so on unless a saved switch says off. `STRATEGY_ENGINE=0` makes the default off. |
| Take-profit | $3.00 net | After modeled fees and slippage. |
| Trade size | $50 | Paper. Under the 50% auto ceiling and the exposure cap. |
| Max open | 2 | Engine positions. `maxOpenPositions` still caps the book. |
| Active variants | `launch-1`, `momentum-1` | 1% stop. Production's hard stop is 2.5% (tighter than the −6% floor) and is checked first, so a 3% or 6% active variant never reaches its own stop on the main book. |
| Daily pause | $10 down on the UTC day | Fixed in `src/strategy/config.ts`. |
| Time limits | 10 min Launch, 30 min Momentum | Fixed in code. |
| Shadow books | six, $100 each | `shadow_trades` table. Open shadow positions are dropped on restart. Ready = 200 trades with a net profit; information only. |

### Live caps

| Setting | Current |
|---|---|
| Live trade $ | **$5** |
| Live daily cap | **$500** |
| Live trail | 5% |
| Live scope | manual only · AI paper |
| Live spent today | $0 (at pull) |

### Stops, trail, slippage, cooldown

| Setting | Current |
|---|---|
| Hard stop | **2.5%** (tighter than the 6% ceiling; cannot be loosened past 6%) |
| Trailing take profit | on |
| Trail arm | 150% |
| Trail gap | 3% |
| Entry slippage | 6% |
| Exit slippage | **6%** |
| Cooldown after a stop | **0** (off) |

### Alerts and other

Near misses, fills, and stops: on. PnL alert %: 0 (off). Sender tip: 0.000005 SOL. `operatorReady`: true (checklist only; it does not arm live or place a trade).

## Provider map

| Role | Env | Hostname (only) | Notes |
|---|---|---|---|
| Enrich (scout) | `SOLANA_RPC_URL` | `solana-mainnet.g.alchemy.com` | secret, not in repo |
| Wallet, marks, swaps | `DESK_WALLET_RPC_URL` | `mainnet.helius-rpc.com` | secret, not in repo |
| RPC websocket | `SOLANA_RPC_WS_URL` | `mainnet.helius-rpc.com` | secret, not in repo |
| Enrich budget | `ENRICH_RPC_CALLS_PER_MIN` | **45** | Hard cap still 20 requests/second |
| Holder pages | `HOLDER_PAGES_MAX` | **0** | Ignored on a non-Helius enrich host (top 20 only) |

**Helius lane caps** (wallet / marks / swaps, `src/market/net.ts`; leave unchanged):

- Read lane `helius`: 10 requests/min (limit 13, burst 3)
- Exec lane `helius:exec`: 8 requests/min (limit 10, burst 2)
- Combined `reqLastMin` never above **18**

Enrich on Alchemy uses the separate `enrich` lane (budget 45/min), not the Helius lanes.

### Scout feeds

| Toggle | Setting | Runtime at pull |
|---|---|---|
| Pump stream | on, locked | live |
| Pump.fun API | on | blocked (Cloudflare challenge on frontend-api-v3; the Pump stream is separate) |
| Bonk.fun / LaunchLab | on | live |
| DexScreener | on | live |
| Gecko | on | live |
| Jupiter | on | live |
| DexPaprika / Meteora | **off** | off |
| Bitquery | on in settings | **off** — no `BITQUERY_API_KEY` in the production env file |

`FEED_MODE=live`, `DEMO_FEED=0`. Pump stream was connected at pull.

## Environment variable names

Production file: `/etc/night-desk/night-desk.env` (mode 0600). Names only follow. Anything marked secret must not appear in this repo.

**Secret, not in repo:** `DESK_TOKEN`, `WALLET_PRIVATE_KEY`, `WALLET_KEYPAIR_PATH` (unset), `SOLANA_RPC_URL`, `DESK_WALLET_RPC_URL`, `SOLANA_RPC_WS_URL`, `PUMPPORTAL_API_KEY` (unset), `BITQUERY_API_KEY` (unset), `OPENAI_API_KEY` (unset).

**Set, non-secret values:**

| Name | Value |
|---|---|
| `LIVE_TRADING` | `true` (phone cannot set this) |
| `HOST` | `127.0.0.1` |
| `PORT` | `4721` |
| `FEED_MODE` | `live` |
| `DEMO_FEED` | `0` |
| `PAPER_BALANCE_USD` | `100` |
| `HOLDER_PAGES_MAX` | `0` |
| `ENRICH_RPC_CALLS_PER_MIN` | `45` |
| `DB_PATH` | `/var/lib/night-desk/desk.sqlite` |
| `LOG_JSONL` | `/var/lib/night-desk/desk.jsonl` |
| `LOG_FILE` | `/var/lib/night-desk/desk.log` |
| `ADVISOR_PATH` | `/var/lib/night-desk/advisor.json` |
| `NODE_OPTIONS` | `--max-old-space-size=384` |
| `STRATEGY_ENGINE` | not set (optional; `1`/`0` sets the engine default). Unset, a 13.31 boot turns the engine on. |

**Present in code, not in the production env file:** `STRATEGY_ENGINE`. Unset, a live feed (`FEED_MODE=live`, `DEMO_FEED=0`) boots the trading engine on (13.31 included). `1` / `true` / `on` forces it on. `0` / `false` / `off` forces it off. The saved phone switch wins after that.

**Present in `.env.example` but not in the production env file** (code defaults apply): `PAPER_RESET`, `SCOUT_ENRICH_CONCURRENCY` (8), `SCOUT_ENRICH_QUEUE` (160), `OPENAI_MODEL` (`gpt-4o-mini`), `PUMP_WS_URL` (`wss://pumpportal.fun/api/data`), `RUGCHECK_API_URL` (`https://api.rugcheck.xyz/v1`), `JUPITER_QUOTE_URL` / `JUPITER_SWAP_URL` (lite-api.jup.ag), `RUG_WALLETS_FILE`. `STRATEGY_ENGINE` is not in `.env.example`.

Wallet public address (ok to publish): `3oyFtbPpWRL1DoMnMe7SojPuYbDyjhdfa1fnDwhs15ha`. The private key stays on the desk host.

## Version, deploy, release flow

| | |
|---|---|
| Code version | **13.57** (`APP_VERSION` in `src/desk/crash-card.ts`). Android `versionName` 13.57, `versionCode` 1357, `applicationId` `com.dirk.nightdesk`. Not deployed at the 1:46 PM ET pull. Dirk set the live daily cap to $500. Other prefs are still the 1:46 PM ET pull. |
| Claude tip in this release | `8b3fe9484c12e41efded821e223891907c3051d6` on `claude/trading-engine` (docs only beyond the engine already merged as 13.30). 13.30 on main is `2bc4475`. |
| Live Oracle at that pull | **13.29**, merge `02ba1c0f0adc21460a20801854e1c9fe79fcf1fd`, tree `1d1d654968ec787335cdcc5a6afde49447fc3462`, path `/opt/night-desk-releases/02ba1c0f0adc21460a20801854e1c9fe79fcf1fd`, release https://github.com/Strobingn/night-desk/releases/tag/v13.29, CI https://github.com/Strobingn/night-desk/actions/runs/42946132006 |
| Env file | `/etc/night-desk/night-desk.env` — left unchanged on deploy. `STRATEGY_ENGINE` stays unset, so 13.31 boots the engine on. |

Standing release pipeline:

1. Wait for hosted CI to finish green on the exact PR head. If it fails, report the failure; do not silently fix it.
2. Review the diff against the hard rules above.
3. Squash-merge, then confirm the merge tree matches the tested head tree.
4. Build the APK and re-sign it with the existing Android debug certificate sha256 `2c69c1b3d33c812142bf0d214e890e084227f01c84f234a8246f2acc7d111f04`. Publish GitHub release `vX.Y` with `NightDesk-vX.Y-debug.apk` and a private Drive copy.
5. Back up Oracle, deploy the merged tree to `/opt/night-desk-releases/<merge sha>`, leave the env file unchanged, and restart only the `night-desk` service.
6. Watch the desk and report version, pipeline, paper cash/equity, live book (no unexpected spends), and provider errors.

**Update these two docs files in that same release PR** so the next reader sees the new version's live settings.

### Snapshot at pull (2026-11-11 1:43 PM ET)

Not settings, but useful context: paper cash $549.86, paper equity $682.87 (marks move), live positions 0, open orders 0, live spent today $0, `operatorReady` true, `lastClientCrash` null, health ok.

## 13.57 notes

The engine cannot live-buy a coin that rugs inside a minute. No numeric exit, cap, or pause changed except the live daily cap Dirk set to $500.

- An engine live buy waits `LIVE_SURVIVAL_MS` (90 seconds) after the signal. Every sample in that window has to stay within 20% of the first sample and at or above the $10,000 live floor, and the pool's age has to cover the window. The quote that confirms the window is the price for the swap, the entry-slippage check, the crash guard, and the sell quote. Inside the buy lock the engine reads liquidity again and refuses unless that sample is a few seconds old (`LIVE_RECHECK_FRESH_MS`, 5 seconds) and still inside the same rules.
- The buy fails closed. Unknown, timed out, or missing safety, bundle, LP lock, liquidity, or sell route means no live buy. LP must be burned or locked (`onBondingCurve` does not pass). Mint and freeze authority must be revoked. The sell check is a quote, and no route means no buy.
- A live engine coin whose pool dies adds its deployer wallet to `rugWallets`. A later engine live buy from that wallet is skipped. Manual buys do not read the list and do not wait out the window.
- Live trade size stays $5. `liveDailyCapUsd` of $500 is inside the existing $1–$100,000 band. The phone's draft cap, when none is saved, is $500.

Not changed: ordinary exits at 6%, rug exits at 50% only, Helius 10/8, cooldown 0, the $10 paper-only pause, the $5 closed-live pause, dead coins off the 6 live slots, and no automatic sells on dead coins.

## 13.56 notes

Dead engine positions are not sold on a loop. No numeric setting changed.

- The live review was sending a dead engine position (no sell route, a collapsed mark, or a known zero wallet balance) to exit on every pass, because its old mark stays under the stop. That filled the Helius lanes and starved safety checks, new buys, and manual trades.
- Those positions, the same ones `engineLiveSlots` does not count, get no automatic exit attempt. They stay on the book and in Dead / no sell route. Manual Sell anyway still sells them.
- Any other automatic live exit waits 20 seconds (`AUTO_EXIT_RETRY_MS`) after an attempt before the next one. During that wait the trail peak still updates. The rug rule and the 6% exit cap are unchanged.

Not changed: live size $5, the daily cap, Helius 10/8, cooldown 0, bogus-price rejection, the $5 closed-live pause, the $10 paper-only pause, the manual-buy override, the rug exit, and the 6% exit cap.

## 13.55 notes

Rug exit and the live slot count. No numeric setting changed.

- A live position whose sell read found a zero token balance is dead for `engineLiveSlots`, the same counter as a no-route or collapsed holding. It stays on the book and in Dead / no sell route. The Engine tab's open count is that counter. Nothing is deleted and the ledger is not rewritten.
- For 3 minutes after an engine live fill, a pool down 35% or more from the buy, read after this fill, emits `RUG_EXIT`. So does a burst of sells into a thinning pool. The previous hold's last depth is not a drain. That sell may pay up to `RUG_EXIT_SLIPPAGE` (50%).
- The 25% pool-drain sell from 13.54 stays on every live variant and stays at the saved 6% cap. If that same reading is down 35% or more inside the 3 minutes, it sells as `RUG_EXIT` instead, so the wider ceiling can be used. A 1% launch stop, a hard stop (`STOP_LOSS`), a gap rug, and the 25% drain itself stay at 6% even inside those 3 minutes.
- A dev or top-10 dump sells only when a chain read the desk already made, while the coin was open, shows the drop. The sighting from before the fill is the entry snapshot. There is no extra holder poll.
- The 1% launch stop still fires when the last mark is older than 30 seconds. That old print is not the sell's mid: the exit cap is checked against the quote's own impact, and the on-chain slippage still caps the send. A fresh mark is still compared with the quote. A connected stream with no recent account update does not replace the pool poll.
- A live fill records slippage against the mark. The old 1.00% figure was the placeholder used when the quote's input amount matched the request.

Not changed: live size $5, the daily cap, Helius 10/8, cooldown 0, bogus-price rejection, the $5 closed-live pause, the $10 paper-only pause, and the manual-buy override.

## 13.54 notes

Dead holdings and the engine's live limit. No setting changed.

- The engine holds `maxOpen` live positions at most. It counted every engine position on the live book, including dead ones: a coin with no sell route, or one whose mark collapsed and stayed there. Those are in the phone's collapsed "Dead / no sell route" section, not the open list. Six of them filled every slot and the engine refused each new signal with "already has 6 live".
- A dead holding no longer takes a slot (`engineLiveSlots`). It stays on the live book and in the Dead section. Nothing is sold, written off or removed.
- `strategy.live.open` now counts tradeable engine positions only, and `strategy.live.dead` counts the dead ones. The Engine tab shows them apart: "0 open now. 6 dead (no sell route), not counted against the engine's limit."
- The live daily cap, the live loss pause and the wallet check still bound what the engine can spend.
- Real-money engine positions now sell when the pool is draining, on every variant: depth down 25% from the buy (`STRATEGY.fade.liquidityDrop`), read from data no older than 60 s. Before, only the fade variants did this, and the live variant in use (Launch, 1% stop) is not one. Paper books are unchanged, so the live variant's scorecard does not include these exits.
- This cannot beat a rug that empties the pool in one transaction. There is no reading in between to act on.

## 13.53 notes

Live sells. No setting changed: exit slippage stays 6%, ceilings stay 10 and 8, 18 together.

What was wrong. Building one Pump curve swap read six accounts (the mint, the curve, Global twice, the fee config, the wallet's token account), then asked for a blockhash and ran the simulation: 8 Helius sends. The swap lane allows 8 a minute with a burst of 2, so sends three to eight went out about 7.5 seconds apart. The price was read on the second send and the order was simulated on the eighth, about 40 seconds later. A coin that is falling, which is when a stop fires, moves more than the 6% exit cap in that time, so the simulation failed and nothing was sent. The attempt also used the lane's whole minute, so the retry 15 seconds later started behind it.

What changed:

- Each address is read once per swap (`swapConnection`). Global was read twice.
- The four Pump program accounts (Global, curve fee config, AMM global config, AMM fee config) are kept 10 minutes. A coin's mint account is kept 60 minutes: its token program cannot change. A failed swap does not empty them, so its retry is just as short; it asks the desk to re-read the four program accounts in the background, at most once in 2 minutes.
- The desk reads those four accounts itself every 8 minutes on the read lane at priority 2, and after a restart reads the mint of every live Pump holding. The safety check that runs before every buy hands its mint read to the swap. So a swap does not spend swap-lane sends on them: a first buy is 4 sends, inside the 5 a minute buys may use.
- A swap's own sends always use the swap lane (`swapLane`), whatever the RPC method. A Jupiter-route sell's token-account read is not moved to the read lane by its priority.
- A curve sell does not read the wallet's token account. Only a buy may need to create it.
- A curve sell is now 3 sends after the first: the curve, the blockhash, the simulation. A buy is 4.
- A live sell runs at priority -1 on the swap lane. It goes ahead of buys, does not wait for a token, and every other send on that lane stops at 5 a minute (`HELIUS_EXIT_RESERVE` = 3), so a sell's three sends are free when a stop or target fires. A sell still cannot pass 8 a minute.

Not changed: the Jupiter route for coins that are not on Pump, the 6% exit cap, the wallet-balance check before a sell.

## 13.52 notes

Fast sweep: the desk goes and looks at parked coins. No threshold or setting changed.

Why it was slow. A Pump stream create carries a name and a creator and no numbers. The free pre-filter parks a coin with no volume until a list feed prints it again. Most new coins never get that second print, so they sat on "checking" and were never scanned. A coin killed for low volume had to wait five minutes and then be printed again by a list feed.

What the sweep does:

- Every parked coin is looked up on DexScreener `/tokens/v1/solana/{mints}`, 30 coins a request, at 10 s, 25 s, 45 s, 75 s, 2, 3, 5, 8 and 12 minutes after it was parked (`SWEEP_LOOKS_MS`). Youngest coins go first.
- Parked means: a sighting the pre-filter is waiting on, or one it killed only for `VOLUME_TOO_LOW`, `LIQUIDITY_TOO_THIN` or `TOKEN_TOO_NEW`. A hard kill (junk name, unusable price, ban, too old, market cap) is never swept. A hard failure the sweep finds on a soft-killed coin is remembered as a hard kill.
- When a look shows one-hour volume at or above the existing minimum and nothing else fails, the coin goes to enrich at once. It does not wait out the five-minute soft-kill backoff. This spends the coin's one soft recheck.
- DexScreener prints no depth for some curve pairs. If volume clears and depth is the only number missing, the coin is promoted and enrich reads depth from the chain. Filter still applies the liquidity floor. A missing age or market cap, when those limits are set, is not waved through: that coin waits for a look that has it.
- A coin that is still quiet stays parked. Only the last look kills it, once.
- A refused or timed-out request decides nothing. The looks go back and the sweep pauses 15 s.

Cost and limits:

- At most 2 requests every 2 s: 60 a minute out of the 240 a minute budgeted for this endpoint, at priority 2 behind enrich and the Tape. That is 1,800 coin looks a minute. Up to 2,000 coins parked at once; the oldest is dropped past that.
- No RPC read. A coin costs its 3 enrich reads only after it passes, the same as before. More coins will pass, so enrich RPC use goes up with them.
- Counters are on `/api` under `prefilter.sweep` and on the phone's Settings pre-filter line: parked, looks, passed.

## 13.51 notes

A holding can land in Dead / no sell route before anyone presses Sell. The card note is still "Liquidity gone, no sell route". Two display checks set it, and neither one sends a transaction or writes the book:

- The mark has collapsed. The position is worth under $0.01 and the mark is at least 99% below entry, or a drop of 99% or more has been seen three times at least 1.5s apart. Identical prints that the chart folds into one point still count. One print above a cent does not move the card.
- A read-only Jupiter quote (GET only, once a minute, one pass at a time, through the shared Jupiter limiter) finds no sell route. A pump-route coin is not judged by that quote. A timeout is not treated as a drained pool. A quote that comes back clears only that flag. A new fill, a finished sell, and a paper reset clear it too. A quote that returns after the coin was sold or bought again is not applied to the new position.

Stops, settings, and the ledger are unchanged. The engine does not sell because of this note. Sell on the card still works, including Sell anyway.

## 13.50 notes

A live sell in the first 30 seconds after a fill is no longer refused because the wallet balance read is stale or failed. The buy already booked the token amount. The sell still tries a fresh wallet read and a fresh token-account read, waits about 750ms, and then sends that booked amount if the read has not answered or comes back empty. A real token balance still caps the sell. Exit slippage stays 6%. Caps stay 10 and 8. A sell of an older position still refuses when the balance cannot be read. No numeric setting changed.

Holdings the desk has marked liquidity gone (no sell route) leave the main paper and live cards. They stay in a collapsed section, "Dead / no sell route (N)", on the Android Home screen and the web Home screen. Details and Sell are still on those cards. Nothing is deleted.

A manual Sell, paper or live, that is over the exit slippage cap asks first. Sell anyway sends that one order past the cap and the confirm shows the expected loss. The engine and every automatic exit still stop at 6%. The 6% setting is unchanged. If there is no route or quote at all, the sell says "No sell route, pool drained" and Sell anyway does not apply.

## 13.49 notes

The launch-bundle check no longer downloads a whole block when it does not have to. No setting changed, and the bundle rule and its thresholds are the same.

- The first call (`getSignaturesForAddress` on the mint) already lists every transaction that touched the coin. The ones in the launch slot are the only ones the check needs.
- Those are now read in one batched `getTransaction` request, at most 10 (`BUNDLE_TX_BATCH_MAX`). That is a few kilobytes, where the slot read is megabytes. Failed transactions are skipped: they moved no tokens.
- Full transactions carry the SOL transfers again, so the same-funder grouping the 13.48 accounts-only block read could not see is back on this path.
- The whole-slot `getBlock` (accounts only, as in 13.48) is still used when more than 10 transactions launched with the coin, or when the batch is refused or comes back with any transaction missing. A missing one could be the bundled buy, so a partial answer is never used.
- The batch can miss a launch-slot transfer that moves the coin between wallets without naming the mint. That can only make the share look higher, never lower. So a clean batch is final, and a flagged batch is checked against the whole slot before it is believed. If that slot read fails, the flag stands and the coin is not bought.
- If the RPC refuses a batched request, the desk stops batching until it restarts and reads the slot directly, so the refusal costs one extra request once and not on every check.
- Still two Helius requests for a buy (three on the fallback), at priority -1 on the read lane for the live engine. A batch is one request to the desk's limiter. Helius may count each call in it, which is why the batch stops at 10.

## 13.48 notes

The engine live launch-bundle check reads the creation slot with `getBlock` `transactionDetails: "accounts"` (`rewards: false`, `maxSupportedTransactionVersion: 0`). Token balances and account keys are still there, so the 20% supply share still flags. Parsed SOL transfers are not in that block, so the same-slot parent check runs only when a response includes them. A timeout and an RPC error are logged as separate reasons, both `LAUNCH_BUNDLE_UNVERIFIED`. Marks and other background reads on the Helius read lane stop at 7/min (`HELIUS_FRONT_RESERVE` = 3) so a priority -1 safety read and its two bundle reads are not left waiting behind them. Caps stay 10 and 8. No numeric setting changed.

## 13.47 notes

Engine token-safety reads wait 8s (`ENGINE_SAFETY_MS`) and the live launch-bundle check waits 15s (`ENGINE_LIVE_BUNDLE_MS`) before failing closed. The one-live-buy lock covers only the buy. Caps stay 10 and 8. Manual-buy timeouts and every numeric setting are unchanged.

## 13.46 notes

Helius read lane, so a buy's checks do not wait for a slot. No setting changed.

- 13.45 put the engine's safety read and the live bundle check at the front of the read lane. The front of the queue still waited for the lane's next token, about 6 s apart when background reads keep the lane at its ceiling. The safety read gives up at 2.5 s and the bundle check at 4 s, so a live buy could still be refused as Unknown or `LAUNCH_BUNDLE_UNVERIFIED`.
- Priority -1 reads on the Helius read lane (wallet balance, a buy's safety and bundle reads) now skip the token bucket. The sliding-minute ceilings still hold them: 10 on the read lane, 18 with the swap lane.
- Priority-2 background reads (watch-list safety and bundle chips) stop at 7 sends a minute (`HELIUS_FRONT_RESERVE` = 3), which leaves room for one buy's three reads. Mark polls (priority 0) are not reserved against and can still use the full 10.
- A waiter that jumps the queue is no longer held until the timer set for the waiter it passed.

## 13.45 notes

Engine token-safety reads (paper and live) and the live engine launch-bundle check use priority -1 on the Helius read lane; a bundle timeout or error skips that live buy (`LAUNCH_BUNDLE_UNVERIFIED`), other non-pause skips log `ENGINE_LIVE_SKIP`, and a timed-out safety read leaves the queue. Caps stay 10 and 8. No numeric setting changed.

A priority -1 safety read (any buy) no longer accepts a cached "Unknown" answer (15 s) or waits on a background read already queued for the same coin: it reads again at the front of the queue. A cached safe or unsafe answer is still reused.

## 13.44 notes

Why the live engine is not buying.

- `strategy.live` gains, all since the desk process started or the live variant last changed: `since`, `signals` (signals of the live variant's kind), `otherSignals` (the other kind, which it does not trade), `buys`, `lastSignalAt`, `lastBuyAt`, `lastSkip` (`at`, `symbol`, `code`, `message`: the last refused live attempt in the buy path's own words), plus `spentTodayUsd` and `dailyCapUsd`.
- The Engine tab shows one line from these under Live money.
- Changed limit: for an engine live buy, `maxTradesPerHour` (default 0 = off) counts live buy fills in the last hour only. Paper engine buys used to count against it, so a set limit could be used up before any live buy. Paper auto-buys are counted as before.
- A fresh-launch coin still on the pump.fun curve is bought with SOL, not USDC. A live buy of one needs about the live trade size in SOL plus fees in the wallet; with USDC only it is refused with `LIVE_WALLET`, and that is now visible in `lastSkip`.
- Nothing else changed: live size, daily cap, the $5 live pause, stops and the checklist are as before.

## 13.43 notes

The $10 UTC-day paper-loss pause applies to paper engine buys only. It does not stop a live engine buy. Live engine buys still pause on the $5 closed-live loss (`STRATEGY.live.dailyMaxLossUsd`). No pause amount, size, cap, stop, slippage, or cooldown changed.

## 13.42 notes

Follow-up to 13.41. No trading rule, limit, stop, cap, default, endpoint or setting changed.

- Live equity curve: after the first read, each new sample is folded into the cached points in memory. A snapshot no longer re-reads the `live_equity` table after every sample. Rows older than 90 days are deleted once a day.
- A JSON reply is gzipped only when `Accept-Encoding` allows it with a q above 0. `gzip;q=0` gets the plain body.
- Replay: the time budget is checked on every quote and between signal opens, and a replay book no longer scans its closed trades on each open.
- Recorder: a held-position tick is saved when pool depth changed at an unchanged price.

## 13.41 notes

Live equity chart, market recording, replay, transport speed. No trading rule, limit, stop, cap or default changed.

- `liveBook.equity` in `/api/state`: up to 240 `{t, equity, cash}` points for the live book (wallet USDC plus live positions). Sampled only while the wallet read is good, a changed value at most every 10 s and an unchanged one once a minute. Stored in the `live_equity` table.
- Market recorder (`src/market/recorder.ts`). Env `MARKET_RECORD_DAYS`: days kept, default 14, max 90, 0 = off. Tables `market_quotes` and `market_signals` in the desk database. A quote is saved for each coin the engine watches or holds, at most every 5 s per coin, and every 30 s when the price has not changed. A signal is saved with the numbers that fired it. Writes are batched in one transaction per engine pass. Rows past the window are deleted hourly. It makes no network call.
- `GET /api/market/quotes?since=&until=&mint=&limit=&format=csv` (limit max 50000), `GET /api/market/signals?since=&until=&limit=`, `GET /api/market/replay?days=` (default 3, at most 250000 quotes). All read-only and behind the desk token.
- Replay (`src/strategy/replay.ts`): every saved signal is taken at the engine's paper size and target, through the shadow-book code, once per rule set: 1/3/6% stop with sell-at-target, or a 4/8/12% trail with the profit lock at breakeven, 25% or 50% of the target, with and without fade exits. No open limit and no daily pause, so rule sets see the same trades. It changes no setting.
- Math check of the 13.40 exits: the evaluator matched an independent reference on 400 random paths. One property to know: with the lock at 50% of the target, a trailing trade is sold about 2.8% under the price where it started trailing, so the 8% and 12% trails only take over once the high is 5.6% and 10.4% above that price. The replay grid tests other lock levels on real data before the default is changed.
- `strategy.recording` in the scorecard: `enabled`, `days`, `quotes`, `signals`, `oldestAt`.
- HTTP JSON replies over 1 KB are gzipped when the client accepts gzip. The phone does not fetch `/api/state` while a socket snapshot is under 4.5 s old.

## 13.40 notes

Trailing and fade exits, and the engine's live variant.

Shadow books: 18 (was 6). The six fixed-target books keep their ids and rules. Twelve trailing books are added, six per signal: `<signal>-3-t4`, `-t8`, `-t12` and the same with `f`. All use a 3% stop (from the entry mark) until the target.

- At the target a trailing book does not sell. It records the mark as its high and from then on sells when the mark is its trail percent under the high (`ENGINE_TRAIL`), or when a sell would net half the target or less (`PROFIT_LOCK`). Before the target it has the same breakeven and time limit as the fixed books. Once trailing it is closed at 4x the signal's time limit.
- An `f` book also sells on a fading run (`FADE_EXIT`): 5-minute volume under 50% of the volume at the buy, sells at least 1.5x buys over 5 minutes with 10 or more trades, or no new high for 90 s (launch) / 180 s (momentum). It sells at any time when pool depth is down 25% from the buy (`LIQUIDITY_DROP`). Volume, trade counts and depth come from the Tape quoter's existing DexScreener pass (`txns.m5` is now read). Data older than 60 s fires nothing. No new network calls.
- `active` may name a trailing variant, so the main paper book can trade one.
- Constants are in `STRATEGY.trail` and `STRATEGY.fade` (`src/strategy/config.ts`). They are starting values.

Live variant: `POST /api/strategy/settings` takes `liveVariant` (a variant id, or `null`). Default `null`. Saved with the other engine settings.

- When a signal fires for the live variant's own signal kind, the desk sends a live buy as well as the paper buy. It needs the engine on, the wallet armed, `operatorReady`, the token-safety and launch-bundle checks, fewer than `maxOpen` live engine positions, and the live day not past the $5 loss pause (`STRATEGY.live.dailyMaxLossUsd`, closed live trades, UTC day). Then the normal live path: `liveTradeUsd`, `liveDailyCapUsd`, wallet balance, entry slippage. A refusal logs `ENGINE_LIVE_PAUSED` or the live path's own code.
- The live take-profit is the paper target scaled to the live size: `targetNetUsd * liveTradeUsd / tradeUsd` ($0.30 at $3 / $50 / $5).
- A live engine position carries the variant's rules and is sold by the same engine exits, as a live sell. The hard stop still goes first.
- Turning the live variant off stops new live buys. Open live positions keep their exits.
- Any other AI live buy is still refused (`LIVE_AI_BLOCKED`). `liveAutoBuy` still cannot be turned on.
- Net results on the live book are measured with the paper fill model against the live cost, so a live exit decision is an estimate of what the sell will net.

## 13.39 notes

A live sell whose Jupiter quote returns `NO_ROUTES_FOUND`, or whose pre-send work (token decimals, token accounts, Jupiter quote) would hang, now answers within a few seconds with a clear reason: no sell route, liquidity gone, exit impact, or a sell-quote timeout. Nothing is sent. Phone live sells use the 45s live HTTP client and show that reason instead of "timeout". When the pool's quote-side liquidity is drained (`liquidity.quote` in USD, not tokens × a stale Dex mid) or Jupiter has no route, the holding card stops treating the mid as sellable value, shows "Liquidity gone, no sell route", and books residual (often ~$0) into equity and P&L so a bogus mid cannot inflate them. A real crash that still has quote-side liquidity still marks and can fire the hard stop. The live position stays open in the ledger and in the wallet; a later sell can retry if a route returns. There is no "Sell anyway" over the 6% exit slippage cap, and that cap is unchanged. Live $5/$20, Helius 10+8, cooldown 0, and the 13.32 manual override are unchanged. Engine and AI stay paper-only. No numeric setting changed.

## 13.38 notes

A manual paper or live buy no longer awaits an uncapped `launchBundle` Helius read (priority 2, `getSignaturesForAddress` / `getBlock`) that can sit behind a full 10/min read lane. The bundle check stays warning-only and uses the existing 1.5s `launchBundleSoon` cap. When the Tape row is not enriched yet, the Jupiter quote and the bonding-curve price fallback are also capped (`LOOKUP_PRICE_MS` and `LOOKUP_CURVE_MS`), and `ensureDepth` uses the same curve budget so a missing pool depth cannot hang the fill. The 13.32 manual override is unchanged. No numeric setting, Helius cap, live $5/$20 limit, exit slippage, cooldown, or engine pause changed. Engine and AI stay paper-only.

## 13.37 notes

Meteora DAMM v2 has no LP token. It is left out of the lock judgment, the same way DLMM is, unless the report has no traditional pool at all (then the lock stays unknown and fails closed). Traditional pools are ranked by real depth, including RugCheck `baseUSD` + `quoteUSD`. A figure-less pool does not veto a pool that has depth. Holder count comes from RugCheck `totalHolders`. A top-20 largest-accounts page is concentration only and is not shown as the holder total. No numeric setting changed. The 13.36 lookup and the 13.35 screens stay.

## 13.36 notes

Search lookup no longer gives the whole chain read a 2s wall. Alchemy `getAccountInfo` starts with RugCheck, partial fields are kept, and a sighting from the last 30 minutes fills only the fields that read did not get, without refreshing their age. LP lock is the deepest traditional pool; locked dollars are not depth, and DLMM or other concentrated pools are not an unlock. The hard stop is measured from the entry mark. `/api/health` `unverifiedKills` counts fail-closed "could not be verified" kills. No numeric setting changed. The 13.35 screens stay.

## 13.35 notes

Phone redesign. Five tabs (Home, Tape, Search, Engine, Settings); Recap, Link and Pump terminal are under Settings → More; the Engine tab holds the engine switch, sizing, scorecard, pipeline timings and Reset scorecard (`POST /api/strategy/reset`). No desk setting, limit or trading behavior changed. One field is added: `strategy.mainOpen` on `/api/state` and the `/api/strategy/*` answers is the number of engine positions open on the main paper book. A variant's own `open` is its shadow book, which can differ. `scripts/bench-snapshot.ts` measures snapshot cost.

## 13.39 notes (Home charts)

Phone only: the Home charts. Position cards get a time-based price chart (entry and stop levels, low and high, finger readout when expanded) and the equity curve gets 1H / 6H / 1D / All windows. No desk setting, endpoint or limit changed.

Math audit, same version. The paper fill model was checked against an exact constant-product pool and matches. Three things were wrong and are fixed:

- The engine's stop (1%, 3% or 6%) was measured from the fill. The fill sits above the mark by entry slippage, so the stop was closer than its percent, and in a pool under about $11,600 a $50 buy was already past its 1% stop at an unchanged price. It is now measured from the entry mark, the same as the hard stop. Shadow books use the same rule, so results before and after this version are not comparable; reset the scorecard.
- A hard stop with a fraction (2.5%) was printed rounded ("limit -3%") in the stop message, the gap message, the custom-stop error and the start log. The line itself was always right. The labels now show 2.5%.
- A position the engine opened showed the desk's hard stop as its stop. It now shows the tighter engine stop, the one that fires first. The advisor's stop distance also used the fill and now uses the entry mark.
