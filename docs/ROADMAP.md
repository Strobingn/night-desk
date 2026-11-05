# Night Desk strategy roadmap

This is a plan for a possible commercial version. Nothing on this page is implemented. Nothing on this page is enabled on the private desk. The private desk stays a paper book with manual live only, fail-closed math, and a hard stop that can only tighten.

Figures that have circulated with the source notes for this plan are unverified estimates. They are not results, and they are not repeated here.

## Bonding-curve graduation arbitrage

Watch a Pump.fun coin as it approaches graduation onto a pooled market. The idea is to trade the gap between the curve price and the first pooled price, then get flat. Sizing, the exact graduation trigger, and whether the gap is still there after fees are unsolved. This desk does not do it.

## Smart-money copy-trading, quarter-Kelly

Follow a small set of wallets whose history is good enough to copy, and size each copy at a quarter of the Kelly fraction so a bad streak cannot bet the bankroll. Wallet selection, delay, and the Kelly inputs (edge and odds) are not defined tightly enough to turn on. This desk does not copy anyone.

## Anti-MEV execution

Send live swaps as a Jito bundle with a tip that moves with congestion, so the fill is less exposed to sandwiching. Tip policy, bundle failure, and what happens when the bundle does not land are not specified. This desk’s live path, when a process is actually armed, is a Jupiter swap. It does not submit Jito bundles.

## Rug / shield analyzer

A harder pre-trade screen than the current filter:

- Mint authority and freeze authority still active.
- Holder entropy, so a “many holders” print that is really one cluster scores as concentrated.
- Block-0 bundle detection, so a launch that was packed in the first block is treated as hostile.

The current filter already fail-closes on unknown mint authority, unlocked LP once a pool exists, top-10 concentration, rugs, and thin volume. Entropy and block-0 detection are not in the pipeline.

## Monetization

Two ideas, neither wired up:

- A platform fee on swaps this product routes.
- A paid pro subscription for the commercial app.

There is no fee collector, no billing, and no public signup. Any revenue projection attached to those ideas elsewhere is an unverified estimate, not something this desk has earned.
