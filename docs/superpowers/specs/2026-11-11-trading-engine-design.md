# Trading engine design (part 1 of 3)

Date: 2026-11-11. Branch: `claude/trading-engine`. Status: waiting for Austin's review.

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

- **Launch.** Coin is under 30 minutes old. Buy pressure is rising: on the Pump trade stream,
  buy volume over the last 60 seconds is at least 1.5 times sell volume across at least 5
  buys. For a pooled coin with no trade stream, 5-minute volume runs at 1.5 times the
  1-hour pace and the last tracked mark is above the first.
- **Momentum.** Coin is 30 minutes old or more. Price is up at least 3% over the last 5
  minutes on the engine's own mark tracker, 5-minute volume runs at 1.5 times the 1-hour
  pace, and the 1-hour price change is positive.

The mark tracker keeps up to 20 Filter-passing coins and a short ring of recent marks for
each, for at most 30 minutes per coin. It reads marks from price feeds the desk already
polls and adds no Helius calls. The implementation plan confirms which existing feed
serves this before any code is written; if none can without new rate-limit pressure, the
tracker size is cut rather than a budget raised.

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
- Daily loss pause at $10, using the existing `dailyMaxLossUsd` gate.
- No averaging down, unchanged.

## Shadow books

Six paper variants run at once on the same signals: Launch and Momentum, each with a 1%,
3% and 6% stop. Each has its own $100 book, positions and closed-trade list, uses the same
paper fill and fee model as the main book, and never places an order. A failure inside a
shadow book is caught and logged and cannot touch the main book.

The main paper book trades one active variant per signal. Default: the 1% stop for both,
as asked. Austin can switch the active variant in settings.

Shadow trades are stored in a new `shadow_trades` table. Shadow positions open at restart
are closed as void and excluded from the scorecard.

## Scorecard

Per variant: closed trades, win rate, average win, average loss, net profit after costs,
average net per trade, worst drawdown, and a `ready` flag (200 or more trades and net
profit above zero). Served at `GET /api/strategy/scorecard`, with a one-line summary in
the snapshot. The phone gets a plain Scorecard card on the Book screen; part 2 restyles it.

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

## Not in this part

App redesign, performance fixes, new safety filters, copy-trading, graduation arbitrage,
Jito bundles, any live auto-trading change.
