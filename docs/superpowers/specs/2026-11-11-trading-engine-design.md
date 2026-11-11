# Trading engine design (part 1 of 3)

Date: 2026-11-11. Branch: `claude/trading-engine`. Status: approved by Austin and built. The last section lists where the build differs from the first draft.

Parts 2 (app redesign) and 3 (speed) get their own specs after this one ships.

## Goal

The desk enters and exits trades on its own, on paper, using Austin's two manual styles
(fresh launches and coins already running), and measures after costs which settings make
money. Nothing in this part sends a real order.

This is a measuring tool, not a promise of profit. A paper result is an upper bound: real
fills are slower and worse than the model.

## What Austin asked for, and how it is handled

| Ask | Handling |
| --- | --- |
| Meme coins only | Unchanged. The desk only scouts Solana meme coins. |
| $100 account, about $3 profit per trade | $50 per trade, 2 open at most. Take-profit fires at $3 net of modeled costs (about a 7% move). |
| 1% stop | Runs as the main paper book's stop and as one of three tested stops. The scorecard decides whether it stays. |
| Many small trades are fine | No per-hour trade cap by default. |
| Never lose money | Not possible. Replaced by: paper first, a $10 daily loss pause, and a scorecard that has to prove an edge. |

## Entries

A signal is only looked at for a coin that already passed the existing Filter (rug,
mint/freeze authority, LP, holder concentration, volume floor) and the analyst trade line.
No existing gate is loosened.

- **Launch.** Coin is under 30 minutes old. Across at least 3 tracked marks spanning 20
  seconds or more, the price is up at least 2%, and 5-minute volume runs at 1.5 times the
  1-hour pace.
- **Momentum.** Coin is 30 minutes old or more. Price is up at least 3% over the last 5
  minutes on the engine's own mark tracker, 5-minute volume runs at 1.5 times the 1-hour
  pace, and the 1-hour price change is positive.

The mark tracker keeps up to 12 Filter-passing coins and a short ring of recent marks for
each, for at most 30 minutes per coin. Watched coins are pinned on the Tape quoter, the
batched DexScreener pass the desk already runs, so the engine adds no network calls and
no Helius reads. A pinned coin is re-quoted roughly every 10 to 16 seconds. A quote is
only used when it comes from the feed the coin is anchored to, because a position is only
ever marked by the feed that priced its entry. Unknown volume is never a pass.

Thresholds above are starting values and live in one config object.

## Exits

All automatic, checked on the existing position loop:

1. **Take-profit.** Estimated net P&L (existing net-of-costs math) reaches the target, $3.
2. **Stop.** Mark falls the variant's stop percent below the fill. Never looser than the
   desk's 6% hard stop, which is untouched.
3. **Breakeven.** Once net P&L reaches half the target, the stop moves up to the price where
   the trade nets zero.
4. **Time limit.** Launch trades close after 10 minutes, Momentum trades after 30.

Exits go through the desk's normal sell path, so the bad-mark guard and exit-impact gate
still apply. A missing or stale mark never triggers a take-profit, breakeven or time exit
on its own price; the hard stop path behaves exactly as today.

## Sizing and pauses

- $50 per trade (the existing 50% auto cap), 2 positions open at most.
- New engine buys pause once the paper book's net result for the UTC day is $10 down
  (closed trades plus open positions). The existing `dailyMaxLossUsd` gate still applies
  on top when it is set.
- No averaging down, unchanged.
- The same coin is not signalled again for 30 minutes.

## Shadow books

Six paper variants run at once on the same signals: Launch and Momentum, each with a 1%,
3% and 6% stop. Each has its own $100 book, positions and closed-trade list, uses the same
paper fill and fee model as the main book, and never places an order. A failure inside a
shadow book is caught and logged and cannot touch the main book.

The main paper book trades one active variant per signal. Default: the 1% stop for both,
as asked. Austin can switch the active variant in settings.

Closed shadow trades are stored in a new `shadow_trades` table. Open shadow positions are
not saved: after a restart they are gone and are never counted. Each shadow book has its
own $10 daily pause on its own net result.

Shadow books only see a price when the Tape quoter re-quotes the coin (about every 10 to
16 seconds), or on every tick when the main book holds the same coin. A dip and recovery
between two quotes is invisible to them, which flatters tight stops. The scorecard says so.

## Scorecard

Per variant: closed trades, win rate, average win, average loss, net profit after costs,
average net per trade, worst drawdown, and a `ready` flag (200 or more trades and net
profit above zero). Served at `GET /api/strategy/scorecard` and carried whole on the
snapshot as `strategy`. `POST /api/strategy/settings` changes the switch, the sizes and the
active variants; `POST /api/strategy/reset` with `confirm: true` wipes the shadow books.
The phone shows it under Settings → Trading engine (a switch, a summary line and the
scorecard); part 2 restyles it.

## Live trading

No change. The engine cannot arm live trading or set `aiBuysLive`. `ready` is information
only. Going live stays Austin's switch.

## Timing measurements (for part 3)

The engine records how long each coin takes from sighting to enrichment, to decision, and
to fill, and exposes the summary in `/api/state`. Part 1 only measures.

## Code layout

New module `src/strategy/`, each file with one job:

- `config.ts` thresholds, variants, defaults
- `mark-tracker.ts` recent marks per watched coin
- `signals.ts` Launch and Momentum decisions (pure functions)
- `exits.ts` take-profit, stop, breakeven, time limit (pure functions)
- `shadow-book.ts` one variant's paper book
- `scorecard.ts` stats from closed trades
- `engine.ts` wires the above to the desk

`src/desk/orchestrator.ts` gets small hooks only: feed marks and trades to the engine, ask
it before an auto-buy, ask it on each position check. Settings gain a `strategy` block
(enabled, target, trade size, max open, active variants). Android: parse the scorecard and
show the card; version 13.30.

## Testing

Vitest, test-first, under `test/strategy/`: signal thresholds at and around each edge, each
exit rule, breakeven math against the cost model, shadow-book isolation (a thrown error
does not reach the main book), scorecard arithmetic, void handling at restart, and a
pipeline test on the replay tape showing an auto entry and an auto exit. Existing tests
must still pass unchanged.

## Switch and default

The engine has one switch, saved on the desk. With nothing saved it is on for live feeds
(`npm run paper:live`) and off on the replay tape, which has no live quotes to signal on.
`STRATEGY_ENGINE=1` or `0` sets the default. Off, the desk behaves exactly as before: an
analyst pass is bought on sight at the saved cap, and winners are closed by hand.

## Where the build differs from the first draft

- The Launch rule does not use a per-coin trade stream. The desk's PumpPortal socket only
  delivers new-token and migration frames; per-token trades are metered and not enabled.
  Launch uses the price ring and volume pace instead.
- The watch list is 12 coins, not 20, to leave room on the Tape quoter's 30-coin batch.
- The daily pause is on the day's net result, not the existing gross-loss gate, so a book
  that is winning is not paused by the size of its losers.
- Open shadow positions are dropped at restart instead of being written as void trades.
- The scorecard card is in Settings, not on Home, so the Home screen the emulator gate
  drives is unchanged.
- Modeled round-trip cost on a $50 trade is about 0.6% in a $200k pool and about 0.9% in a
  $50k pool, higher than the 0.5% quoted in conversation.

## Not in this part

App redesign, performance fixes, new safety filters, copy-trading, graduation arbitrage,
Jito bundles, any live auto-trading change.
