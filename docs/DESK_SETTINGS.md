# Night Desk settings

Last updated: 2026-11-11 2:33 PM ET (13.31). Live prefs and rules are the 1:46 PM ET pull.

These files (`docs/DESK_SETTINGS.md` and `docs/desk-settings.json`) are the canonical, repo-readable snapshot of how the production desk is wired and what it is set to. Prefs and rules were pulled from the live Oracle host (`/api/state`, `/api/health`, `/api/wallet`, `/api/live/ready`, `/api/orders`) at 1:46 PM ET, while that host was still **13.29** (`02ba1c0f0adc21460a20801854e1c9fe79fcf1fd`). **13.30** added the trading engine, its code settings, `/api/strategy/*`, and the phone's Oracle fallback (`https://night-desk.157-151-200-171.sslip.io`, ahead of the old trycloudflare default). **13.31** brings Claude's tip `8b3fe9484c12e41efded821e223891907c3051d6` onto that release. The engine code matches the patches already in 13.30 (through `9f6bd0d`); the new commit is his desk-settings note. Those engine numbers are the code in `src/strategy/config.ts`, not a second live pull. The author of `8b3fe94` had no desk token, so `/api/strategy/*` was not re-pulled and must be pulled after deploy. Oracle does not serve the engine until this release is deployed.

**Every Night Desk release must update both files in the same PR.** Re-pull live settings, and add any new endpoints, env names, or controls the release introduces. Never put token values, private keys, or RPC URLs that carry an API key (path or query) in this repo. Hostnames only. A wallet pubkey is fine.

Machine-readable copy: [`docs/desk-settings.json`](desk-settings.json).

## Hard rules

- AI stays paper-only. `liveAutoBuy` cannot be turned on. `POST /api/settings` with `liveAutoBuy: true` is refused. Live scope is manual: an operator buy, limit, or stop may send a real swap; AI auto-buys never spend live. The 13.30 trading engine is the same rule: its buys call the paper book only, and its exits do not set `book: "live"`.
- The desk's hard stop is checked before an engine exit. A mark at or past the hard stop closes as `STOP_LOSS` or `GAP_RUG`, not as the engine's own stop. The engine's stop (1% on the main paper book) can only be tighter.
- Never drop the v13.11 baseline controls (paper and live limit / take-profit / stop orders, and the rest of that book and ticket UI).
- Bogus-price rejection stays on (`src/market/mark-guard.ts`). Non-finite or non-positive prints are rejected. Implausible upward jumps and unit / decimal or SOL-vs-USD mix-ups (including a rise of 25× or more) do not update equity or stops unless confirmed. A genuine crash is never rejected by this guard, so the hard stop can still fire.
- The hard stop cannot be loosened past 6%. `LIVE_TRADING`, the wallet secret, and mode cannot be changed from the API.
- 13.30: the trading engine trades the paper book only. Its buys go through the analyst path, which refuses the live book. The engine stop can only sit tighter than the hard stop and never moves it. The scorecard `ready` flag arms nothing.
- 13.31 keeps that engine. It does not add a live order path, move the hard stop, change the Helius 10/8 caps, or change the live $5 / $20 limits.
- Leave live trade size at $5 and the daily cap at $20, exit slippage at 6%, cooldown at 0, and the Helius lane caps (10 read + 8 exec, combined `reqLastMin` never above 18) unless Dirk approves a change.

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
| GET | `/api/health` | `ok`, `mode`, `now`, `publicUrl` (null on the Caddy host) |
| GET | `/api/state` | `appVersion`, `mode`, `liveScope`, `liveBook`, `wallet`, `readiness`, `cashUsd`, `equityUsd`, `startingBalanceUsd`, `sessionPnlUsd`, `prefs`, `rules`, `positions`, `closed`, `orders`, `feed`, `pipeline`, `killReasons`, `recheck`, `enrich`, `events`, `advice`, `watchlist`, `exposureUsd`, `positionCapUsd`, `cooldowns`, `rawTape`, `tapeQuotes`, `markLoop`, `safetyChips`, `lastClientCrash`, `strategy`, `perf`, `now` |
| GET | `/api/strategy/scorecard` | `ok`, `strategy` (same scorecard as `state.strategy`): engine settings, watch count, six shadow-book rows (`trades`, `wins`, `winRate`, `avgWinUsd`, `avgLossUsd`, `netUsd`, `avgNetUsd`, `maxDrawdownUsd`, `open`, `active`, `ready`), `stats`, `note`. Paper only. |
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

The $10 pause is a code constant (`STRATEGY.dailyMaxLossUsd` in `src/strategy/config.ts`). It is not a `POST /api/strategy/settings` field. New engine buys stop for the rest of the UTC day once today's paper result is $10 down. Shadow books use the same pause. It does not change the live $5 / $20 caps.

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
| Live daily cap | **$20** |
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
| Code version | **13.31** (`APP_VERSION` in `src/desk/crash-card.ts`). Android `versionName` 13.31, `versionCode` 1331, `applicationId` `com.dirk.nightdesk`. Not deployed at the 1:46 PM ET pull. |
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
