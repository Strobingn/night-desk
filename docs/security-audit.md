# Trading execution and security review

This change targets the actual TypeScript desk on GitHub `main`. The supplied report describes a different application: `app/[transport]/route.ts`, `lib/sniper.ts`, Geyser, launchpad, and webhook handlers do not exist here. Their alleged vulnerabilities, revenue leakage percentages, and profitability estimates were not established by a code audit of this repository.

## Changes

| Report concern | Implementation in this desk |
| --- | --- |
| TRD-01: execution exposure and slippage | Optional private Jito submission, no public fallback, quote identity/amount/minimum checks, maximum 100 bps slippage and 100 bps quoted price impact, signed transaction simulation. RPC remains the default. |
| FIN-01: atomic fees | Optional native Jupiter USDC fee in the swap instruction. Verify fee parameters, initialized USDC recipient, transaction membership, simulated fee credit, and confirmed fee credit. No separate SOL-denominated fee on a USDC trade. Fees default to zero. |
| PERF-01: transaction construction | Preserve Jupiter's v0 message and address lookup tables, request simulated compute limits, resolve referenced tables, reject oversized packets. No arbitrary fixed 250,000 CU limit. |
| SEC-01: unauthorized commands | Existing desk token gate retained. Default localhost binding, mandatory token on non-loopback bindings, browser origin checks on HTTP/WebSocket, strict HttpOnly cookies, and no-referrer responses. No MCP endpoint was added. |
| RISK-01: unsafe mints/holders | Require explicit mint and freeze authority revocation. Reject unsupported Token-2022 extensions. Aggregate observed token accounts by owner, reject malformed holder data, and veto reported insider supply above 18%. |
| REL-01: duplicate order execution | No webhook endpoint exists. A persistent SQLite single-order guard prevents concurrent live submissions and automatic retries after an ambiguous result, including across restarts. Ledger settlement and releasing the guard commit in one database transaction. |

Live fills come from confirmed token balance deltas, not quote estimates. Confirmation uses the blockhash actually signed in the Jupiter transaction and its returned expiry height, and checks on-chain errors. Sell proceeds are recorded after fees without charging the same fee twice. Exact raw token quantities survive on the position for later sells. SOL network fees are logged as lamports; they are not silently converted into a guessed USD cost.

The existing $100 paper default, 8% maximum position, 6% hard stop, manual winner exits, scoring weights, and user interface remain. Armed live mode cannot trade replay candidates. Paper reset cannot wipe a live book. Paper/live books, equity series, and closed-trade queries are separated. Legacy untagged books are readable only as paper books. Historical untagged equity is classified as paper, not silently imported into live results. A pre-upgrade live book needs operator reconciliation before live trading resumes.

## Configuration

Start with paper trading. These settings affect live execution only:

```dotenv
LIVE_EXECUTION_TRANSPORT=rpc
LIVE_SLIPPAGE_BPS=100
LIVE_MAX_PRICE_IMPACT_BPS=100
PLATFORM_FEE_BPS=0
JUPITER_FEE_ACCOUNT=
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf/api/v1/bundles
JITO_TIP_LAMPORTS=10000
JUPITER_API_KEY=
```

- `jito` requests a tip in the same Jupiter swap transaction, discovers tip accounts via Jito, verifies the configured tip, and sends one base64 transaction through `sendBundle`. It still waits for on-chain confirmation. Bundle acceptance alone never books a fill. Keep enough SOL for rent, network fees, and the configured tip.
- Jito tip discovery and submission share a local limiter aligned to the public default of one request per second per IP/region. Other services sharing the same public IP can still exhaust that budget. This path does not promise block-zero or sub-100 ms execution.
- Fees require `PLATFORM_FEE_BPS` from 1 to 100 and an already initialized USDC SPL token account owned by a separate treasury wallet. A SOL wallet address is not a fee account. Example: 85 bps is 0.85%, or $8.50 on $1,000. The same USDC fee account works for buys and sells because all desk swaps have a USDC leg. This implements only this server's signed execution path; it cannot impose a fee on transactions submitted elsewhere.
- Slippage and price-impact settings can be tightened below 100 bps. Invalid settings stop configuration rather than opening a wider risk budget. Jito tips are bounded to 1,000–1,000,000 lamports. The adapter retains the existing Jupiter `/swap/v1` contract. Configure a compatible provider URL and `JUPITER_API_KEY` when required; it does not silently migrate to a different API contract.
- Normal startup remains local and tokenless. Phone/LAN access needs a long random `DESK_TOKEN`; a LAN binding also needs `HOST=0.0.0.0`. Compose explicitly requires the token and exposes the container on host localhost. Reverse proxies must preserve the external Host header for same-origin browser checks. No cross-origin browser API access is enabled.

## Unresolved live orders

Before sending signed bytes, the executor persists the signature, signed blockhash, expiry height, mint, side, and timestamp in `live_order_guard`. Until the confirmed fill and ledger writes commit, another live order is refused. On a definitive on-chain error the guard can be released without a fill. Transport failures, missing receipts, or inconsistent confirmed balances keep the guard and display a banner. No new transaction is generated to guess whether the old one landed.

Stop every desk process sharing the database before operator recovery. Back up `desk.sqlite` and its WAL consistently, inspect `live_order_guard.details` and the transaction on-chain, and reconcile the wallet's token balances with `kv` key `book:live` and the `trades` table. Clear the guard only after recording a landed fill or proving the order could not land. A row still marked `preparing` means no signed transaction had been durably recorded; verify that no process is still preparing it. There is deliberately no HTTP endpoint that blindly clears a pending transaction. Ledger operation assumes one active desk process and one dedicated trading wallet; the guard prevents simultaneous submissions against the same SQLite database, not every possible stale-book conflict between independent deployments.

## Limits and deferred strategy work

This is execution hardening, not a claim of guaranteed profit or safety:

- Jito reduces public broadcast exposure; it is not a universal sandwich-proof guarantee. Tips do not guarantee inclusion. Tight slippage can cause trades or exits to fail, and a stop is a trigger rather than a guaranteed execution price.
- Largest-account and capped DAS reads do not identify every wallet or hidden related-wallet cluster. Reported insiders are a lower-bound veto, not proof of a safe creator cluster. Full developer funding graphs, bundle attribution, and recycled-social-link detection need additional indexed data and validation. Network enrichment cannot promise a 50 ms result.
- Bonding-curve migration and copy-trading strategies need current program-specific adapters, executable price data, fees/tips, historical replay, and out-of-sample evaluation before live deployment. The proposed 2x capital-recovery rule and 25% trailing stop were not substituted for the desk's existing manual winner exits and 6% hard stop. A remaining position retains market and execution risk after capital recovery.
- Artificial volume and holder-count boosting through coordinated wallets is not implemented. Subscription, referral, launchpad, and performance-fee services are also separate products, not existing capabilities activated by this patch.
- $6,000,000 of monthly volume at 0.85% yields $51,000 of gross swap fees before costs, rebates, taxes, and losses. The report's totals and SOL conversions are scenarios, not measured revenue or net-profit forecasts. No projected profit is recorded as earned revenue.

## Validation

Regression coverage includes quote tampering, missing decimals, simulation errors, failed confirmations, missing receipts, uncertain sends, private-only Jito submission, ALT preservation, atomic fee verification, duplicate candidates, durable guards, rollback, mode isolation, mint/freeze evidence, risky extensions, holder aggregation, and browser origin checks. Tests use synthetic transactions and mocked RPC/provider responses; they do not spend money. CI verifies Node 22 and 24, typechecks the server and UI, runs the complete suite, and builds both bundles. A funded mainnet smoke test is outside this change.

## Protocol references

- [Jito low-latency submission, bundle status, and limitations](https://docs.jito.wtf/lowlatencytxnsend/)
- [Jupiter Metis fee-account and platform-fee contract](https://github.com/jup-ag/docs/blob/acbe70268b8bb985362548e36ac2e76a8ac89631/swap/v1/add-fees-to-swap.mdx)
- [Jupiter transaction sending and dynamic compute limits](https://github.com/jup-ag/docs/blob/acbe70268b8bb985362548e36ac2e76a8ac89631/swap/v1/send-swap-transaction.mdx)
- [Solana Token-2022 extension behavior](https://www.solana-program.com/docs/token-2022/presentation)
