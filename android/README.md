# Night Desk watcher

Android app for the desk. It does not store a seed, a private key, or a wallet vault. Buy sends `POST /api/positions/buy` for a mint you select on the tape. Close sends the desk’s manual-close route. The −6% hard stop still belongs to the desk. The advisor card only displays what the desk is already saying. The Live ready card is a checklist. Its switch stores `operatorReady` only. It cannot set `LIVE_TRADING`.

Application id: `com.dirk.nightdesk`.

## Point it at Austin

1. On the desk machine, paper is `npm run paper` (or `npm run paper:live` for live feeds, still paper trading). It listens on port **4721**.
2. Leave `cloudflared` running. `npm run tunnel` or `scripts/ensure-tunnel.ps1` starts it only if it is not already pointed at 4721, then writes the hostname for the phone beacon.
3. Open the app. It asks the beacon for the current tunnel before it connects, and again if the socket drops. A saved Link URL is the fallback. Home Wi‑Fi can still reach `http://192.168.1.242:4721` when that port answers and the beacon does not.
4. If `DESK_TOKEN` is set, paste that token in **Link**. Leave it blank when the desk is local-open. **Hold this URL** is the manual override. Leave it off so a new tunnel hostname is picked up without pasting.
5. Book, advisor, and tape update from the WebSocket snapshot and a 3-second poll. Advisor text changes when marks and events change. It never trades.

The 1h volume floor is on the book screen. Apply writes `POST /api/settings`. The desk stores it and the next filter check uses it. Range $1,000–$500,000. Unset, it stays $10,000. A saved floor, including $1,000, wins on the next boot.

Each open position has Chart, Birdeye, and Jupiter. Those open the Solana mint in the phone browser. Close is still the desk close. The chart links do not trade.

On **Tape**, Select a line that has a mint, then **Buy**. Leave the size blank to use the position cap, or enter a smaller USD size. The desk refuses a size above the cap and refuses a second buy while that mint is open. The fill is paper until Austin restarts the desk in live mode.

**Live ready** on the Book screen shows mode, the `LIVE_TRADING` flag, and whether the Austin host keypair file is present (plus the public address when the desk could read it). Marking the checklist ready does not arm real money and does not save a Phantom wallet.

**Reset book** on the Book screen asks before it runs. It returns the paper book to $100, drops open positions without an order, and leaves the log, advisor memory, and volume floor. It does not enable live trading.

- Chart: `https://dexscreener.com/solana/<mint>`
- Birdeye: `https://birdeye.so/token/<mint>?chain=solana`
- Jupiter: `https://jup.ag/tokens/<mint>`

## Build

Android Studio (JDK 17, SDK 35):

```bash
cd android
# local.properties is gitignored. Point it at your SDK, or set ANDROID_HOME.
./gradlew :app:assembleDebug
```

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

Install: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
