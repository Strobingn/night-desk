# Night Desk watcher

Android app for the paper desk. Version **13.12** (`versionCode` 1312). It does not place its own orders. Close sends the desk’s manual-close route. The −6% hard stop still belongs to the desk. The advisor card only displays what the desk is already saying.

Application id: `com.dirk.nightdesk`.

Each open position shows mark P&L, after-slippage net, and a small price sparkline. Net is withheld when the mark is missing or stale. See the root [README](../README.md) for the formula.

## Point it at Austin

1. On Austin the desk is `npm run paper:live` in `C:\Users\Austin\ndesk2`, kept up by the scheduled tasks in the root README. The code default port is **4721**. Austin currently uses **4788** because `wslrelay.exe` owns 4721.
2. Same machine: `http://127.0.0.1:4788` (or `4721` only when nothing else is bound there).
3. Away from home: the Cloudflare quick tunnel. The current hostname is in `data/public-url.txt` on Austin. Do not commit that file. This build’s Link screen stores the URL you paste. It does not auto-follow that file yet.
4. If `DESK_TOKEN` is set, paste that token in **Link**. Leave it blank when the desk is local-open.
5. **Save and follow the feed.** Book, advisor, and tape update from the WebSocket snapshot and a 3-second poll. Advisor text changes when marks and events change. It never trades.

The 1h volume floor is on the book screen. Apply writes `POST /api/settings`. The desk stores it and the next filter check uses it. Range $1,000–$500,000. Unset, it stays $50,000.

Each open position has a sparkline plus Chart, Birdeye, and Jupiter. Those links open the Solana mint in the phone browser. Close is still the desk paper close. The chart links do not trade. The card shows mark P&L and net (after the configured sell slippage).

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
