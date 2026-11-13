package com.dirk.nightdesk

import org.json.JSONObject
import org.json.JSONArray

data class AdviceNote(
    val id: String,
    val stance: String,
    val text: String,
    val symbol: String?,
    val mint: String? = null,
    val code: String? = null,
    val score: Double? = null
)

data class PricePoint(val t: Long, val priceUsd: Double)

data class PositionRow(
    val mint: String,
    val symbol: String,
    val pnlUsd: Double,
    val pnlPct: Double,
    val markPrice: Double,
    val stopPrice: Double,
    val entryPrice: Double,
    val score: Double,
    val source: String,
    val entry: String,
    val lpUnlocked: Boolean,
    val markAgeMs: Long,
    val costUsd: Double = 0.0,
    val marketValueUsd: Double = 0.0,
    val openedAt: Long = 0L,
    /** v12. "manual · pump.fun" etc. Null for auto buys. */
    val tag: String? = null,
    /** v13 stop→trail bar. 0 when the desk did not send it. */
    val peakPrice: Double = 0.0,
    /** v13.2 local wall time the shown mark was taken (receive time − markAgeMs). */
    val markLocalAt: Long = 0L,
    /** v13.2 "chain" (pool reserves), "dexscreener", "jupiter", … */
    val markFeed: String = "",
    /** v13.7 true = a real-money position in the live book. */
    val live: Boolean = false,
    /** After-slippage net. Null when the mark is missing or stale. */
    val netPnlUsd: Double? = null,
    val netPnlPct: Double? = null,
    val exitSlippage: Double? = null,
    val marks: List<PricePoint> = emptyList(),
    /** v13.23 "Safe", "Blocked: …", or "Unknown". */
    val safetyChip: String = "",
    /** v13.23 "Bundled 24%" when the creation slot is flagged. */
    val bundleChip: String = "",
    /** v13.39: quote side drained or no sell route. Mid is not sellable value. */
    val liquidityNote: String = ""
) {
    val stopDistancePct: Double
        get() {
            if (!markPrice.isFinite() || !stopPrice.isFinite() || markPrice <= 0) return 0.0
            val distance = ((markPrice - stopPrice) / markPrice) * 100.0
            return if (distance.isFinite()) distance else 0.0
        }
}

data class TapeEvent(
    val id: String,
    val ts: Long,
    val stage: String,
    val kind: String,
    val message: String,
    val code: String?,
    val mint: String?,
    val symbol: String?,
    /** v13: analyst score / kill codes / scout source, used by the coin cards. */
    val detail: String? = null
)

data class LiveReadiness(
    val mode: String,
    val liveTradingFlag: Boolean,
    val keypairPresent: Boolean,
    val walletPublicKey: String?,
    val rpcPresent: Boolean,
    val operatorReady: Boolean,
    val lines: List<String>
)

/** v13.5 read-only wallet card. Never carries the private key or the RPC URL. */
data class WalletInfo(
    val keyLoaded: Boolean,
    /** "env" = WALLET_PRIVATE_KEY, "file" = WALLET_KEYPAIR_PATH. */
    val keySource: String?,
    val keyInvalid: Boolean,
    val publicKey: String?,
    val solBalance: Double?,
    val usdcBalance: Double?,
    /** SOL/USD already on the desk. Null when the desk has not priced SOL. Display only. */
    val solPriceUsd: Double? = null,
    val balanceAt: Long?,
    val balanceError: String?,
    val live: Boolean,
    val liveRequested: Boolean,
    val rpcPublic: Boolean,
    val liveSpentTodayUsd: Double,
    val minFeeSol: Double,
    /** v13.7 "Live: manual only · AI: paper" etc. Null on an older desk. */
    val liveScopeLine: String? = null
)

/** v13.7 armed desk: the live book (real money), apart from the AI's paper book. */
data class LiveBookInfo(
    /** "manual" = only Dirk's buys are live, the AI stays on paper. "all" = the AI buys live too. */
    val scope: String,
    val line: String,
    val cashUsd: Double,
    /** False when the latest read failed or has not happened. An older desk omits this and is treated as known. */
    val cashKnown: Boolean = true,
    val balanceError: String? = null,
    val equityUsd: Double,
    val openPnlUsd: Double,
    val positions: List<PositionRow>,
    val tradeUsd: Double,
    val trailPct: Double,
    val dailyCapUsd: Double?,
    /** v13.41 the live book's equity over time. Empty on an older desk or before the first good wallet read. */
    val equityPoints: List<EquityPoint> = emptyList(),
    /** What the live book started with. 0 when the desk has not measured it. */
    val startingUsd: Double = 0.0,
    /** Live equity minus the starting figure. 0 when the start is unknown. */
    val pnlUsd: Double = 0.0
) {
    val manualOnly: Boolean get() = scope != "all"
}

data class DeskNotice(val ok: Boolean, val text: String)

data class ClosedTradeRow(
    val id: String,
    val symbol: String,
    val exitCode: String,
    val closedAt: Long,
    val entryPrice: Double,
    val exitPrice: Double,
    val pnlUsd: Double
)

/** v12 watchlist row from /api/state or /api/watchlist. */
data class WatchRow(
    val mint: String,
    val symbol: String,
    val platform: String,
    val addedAt: Long,
    val addedPriceUsd: Double,
    val lastPriceUsd: Double?,
    val changePct: Double?,
    val dexscreenerUrl: String
)

data class LookupCheck(val code: String, val pass: Boolean, val message: String)

/** v12 GET /api/lookup. ok=false carries error and code (LOOKUP_FAILED or PRICE_UNAVAILABLE). */
data class CoinLookup(
    val ok: Boolean,
    val error: String? = null,
    val code: String? = null,
    val mint: String = "",
    val symbol: String = "",
    val name: String = "",
    val platform: String = "",
    val tag: String = "manual",
    val priceUsd: Double = 0.0,
    val liquidityUsd: Double = 0.0,
    val volume1hUsd: Double = 0.0,
    val marketCapUsd: Double? = null,
    val ageSeconds: Double = 0.0,
    val dexscreenerUrl: String = "",
    val priceSource: String = "dexscreener",
    val checks: List<LookupCheck> = emptyList(),
    val filterPass: Boolean = false,
    val hardKills: List<LookupCheck> = emptyList(),
    val analystScore: Double = 0.0,
    val analystLine: Double = 0.0,
    val analystPass: Boolean = false,
    val poolMaxUsd: Double = 0.0,
    val positionCapUsd: Double = 0.0,
    val manualMaxUsd: Double = 0.0,
    val cashUsd: Double = 0.0,
    val maxEntrySlippage: Double = 0.03,
    val held: Boolean = false,
    val watching: Boolean = false,
    val canBuy: Boolean = false,
    val buyBlockedReason: String? = null,
    /** v13.6 "QTFALCN · held / traded" when a ticker resolved to this coin. */
    val matchedBy: String? = null,
    /** v13.17 provider failure, not-found detail, or a cached search list (up to 60s). */
    val providerNote: String? = null,
    val safetyChip: String = "",
    val bundleChip: String = "",
    /** v13.6 code AMBIGUOUS: several coins match a ticker/name; pick one. */
    val query: String? = null,
    val candidates: List<CoinCandidate> = emptyList()
) {
    /** Largest size the slider offers: manual max (100% with confirm) and cash, never below $1. */
    val sliderMaxUsd: Double
        get() = kotlin.math.floor(kotlin.math.min(manualMaxUsd, cashUsd).coerceAtLeast(1.0))
}

/** v13.6 one row of the ticker/name pick list. */
data class CoinCandidate(
    val mint: String,
    val symbol: String,
    val name: String,
    val mintShort: String,
    val liquidityUsd: Double?,
    val volume1hUsd: Double?,
    val held: Boolean,
    val origin: String,
    val exact: Boolean
) {
    /** "6Fpq…pump · liq $125.3K · 1h vol $34.3K · held" (same text as the web). */
    val line: String
        get() = "$mintShort · liq ${compactCandidate(liquidityUsd)} · 1h vol ${compactCandidate(volume1hUsd)} · " + when (origin) {
            "position" -> "held"
            "trade" -> "traded"
            "tape" -> "Tape"
            "dexscreener" -> "DexScreener"
            else -> origin
        }
}

fun compactCandidate(n: Double?): String {
    if (n == null || !n.isFinite()) return "—"
    return when {
        n >= 1e9 -> "$" + "%.1f".format(java.util.Locale.US, n / 1e9) + "B"
        n >= 1e6 -> "$" + "%.1f".format(java.util.Locale.US, n / 1e6) + "M"
        n >= 1e3 -> "$" + "%.1f".format(java.util.Locale.US, n / 1e3) + "K"
        else -> "$" + "%.0f".format(java.util.Locale.US, n)
    }
}

fun parseCandidates(rows: org.json.JSONArray?): List<CoinCandidate> = buildList {
    if (rows == null) return@buildList
    for (i in 0 until rows.length()) {
        val row = rows.optJSONObject(i) ?: continue
        val mint = row.optText("mint")
        if (mint.isBlank()) continue
        fun num(key: String): Double? = if (row.has(key) && !row.isNull(key)) row.optDouble(key).takeIf { it.isFinite() } else null
        add(
            CoinCandidate(
                mint = mint,
                symbol = row.optText("symbol", mint.take(6)),
                name = row.optText("name"),
                mintShort = row.optText("mintShort", mint.take(4) + "…" + mint.takeLast(4)),
                liquidityUsd = num("liquidityUsd"),
                volume1hUsd = num("volume1hUsd"),
                held = row.optBoolean("held", false),
                origin = row.optText("origin"),
                exact = row.optBoolean("exact", true)
            )
        )
    }
}

fun parseLookup(raw: String): CoinLookup {
    val root = try {
        JSONObject(raw)
    } catch (_: Throwable) {
        return CoinLookup(ok = false, error = "Lookup failed: the desk sent a bad reply.", code = "LOOKUP_FAILED")
    }
    if (!root.optBoolean("ok", false)) {
        return CoinLookup(
            ok = false,
            error = root.optText("error", "Lookup failed. No buy without a reliable price."),
            code = root.optText("code", "LOOKUP_FAILED"),
            query = root.optText("query").ifBlank { null },
            candidates = parseCandidates(root.optJSONArray("candidates")),
            providerNote = root.optText("providerNote").ifBlank { null }
        )
    }
    fun checks(key: String): List<LookupCheck> = buildList {
        val rows = root.optJSONArray(key) ?: return@buildList
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            add(LookupCheck(row.optText("code"), row.optBoolean("pass", false), row.optText("message")))
        }
    }
    val analyst = root.optJSONObject("analyst")
    val price = root.optFinite("priceUsd")
    if (!(price > 0)) return CoinLookup(ok = false, error = "No reliable price for that coin. No buy.", code = "PRICE_UNAVAILABLE")
    return CoinLookup(
        ok = true,
        mint = root.optText("mint"),
        symbol = root.optText("symbol", "—"),
        name = root.optText("name"),
        platform = root.optText("platform"),
        tag = root.optText("tag", "manual"),
        priceUsd = price,
        liquidityUsd = root.optFinite("liquidityUsd"),
        volume1hUsd = root.optFinite("volume1hUsd"),
        marketCapUsd = if (root.has("marketCapUsd") && !root.isNull("marketCapUsd")) root.optFinite("marketCapUsd") else null,
        ageSeconds = root.optFinite("ageSeconds"),
        dexscreenerUrl = root.optText("dexscreenerUrl"),
        priceSource = root.optText("priceSource", "dexscreener"),
        checks = checks("checks"),
        filterPass = root.optBoolean("filterPass", false),
        hardKills = checks("hardKills").map { it.copy(pass = false) },
        analystScore = analyst?.optFinite("score") ?: 0.0,
        analystLine = analyst?.optFinite("line") ?: 0.0,
        analystPass = analyst?.optBoolean("pass", false) ?: false,
        poolMaxUsd = root.optFinite("poolMaxUsd"),
        positionCapUsd = root.optFinite("positionCapUsd"),
        manualMaxUsd = root.optFinite("manualMaxUsd"),
        cashUsd = root.optFinite("cashUsd"),
        maxEntrySlippage = root.optFinite("maxEntrySlippage", 0.03),
        held = root.optBoolean("held", false),
        watching = root.optBoolean("watching", false),
        canBuy = root.optBoolean("canBuy", false),
        buyBlockedReason = root.optText("buyBlockedReason").ifBlank { null },
        matchedBy = root.optText("matchedBy").ifBlank { null },
        providerNote = root.optText("providerNote").ifBlank { null },
        safetyChip = root.optText("safetyChip"),
        bundleChip = root.optText("bundleChip")
    )
}

fun parseWatchRows(rows: org.json.JSONArray?): List<WatchRow> = buildList {
    if (rows == null) return@buildList
    val seen = HashSet<String>()
    for (i in 0 until rows.length()) {
        val row = rows.optJSONObject(i) ?: continue
        val mint = row.optText("mint")
        if (mint.isBlank() || !seen.add(mint)) continue
        add(
            WatchRow(
                mint = mint,
                symbol = row.optText("symbol", mint.take(4)),
                platform = row.optText("platform", "mint"),
                addedAt = row.optFinite("addedAt").toLong(),
                addedPriceUsd = row.optFinite("addedPriceUsd"),
                lastPriceUsd = if (row.has("lastPriceUsd") && !row.isNull("lastPriceUsd")) row.optFinite("lastPriceUsd") else null,
                changePct = if (row.has("changePct") && !row.isNull("changePct")) row.optFinite("changePct") else null,
                dexscreenerUrl = row.optText("dexscreenerUrl", "https://dexscreener.com/solana/$mint")
            )
        )
    }
}

/** First Solana mint or supported link inside shared text (a share sheet often adds a title line). */
fun extractSharedCoin(text: String?): String? {
    if (text.isNullOrBlank()) return null
    val url = Regex("""https?://\S+""").find(text)?.value?.trimEnd(')', '.', ',', '"', '\'')
    if (url != null) return url
    return Regex("""\b[1-9A-HJ-NP-Za-km-z]{32,44}\b""").find(text)?.value
}

data class MintCooldown(val mint: String, val until: Long, val minutesLeft: Int)

data class DeskSnapshot(
    val mode: String,
    val cashUsd: Double,
    val equityUsd: Double,
    val sessionPnlUsd: Double,
    val minVolume1hUsd: Double,
    val analystMinScore: Double,
    /** v13.1 analyst volume boost, 0–1. Null when the desk is older than v13.1. */
    val volumeBoost: Double? = null,
    val maxTop10Pct: Double,
    val maxPositionPct: Double,
    val stopLossPct: Double,
    val maxEntrySlippage: Double,
    val defaultBuyUsd: Double?,
    val maxOpenPositions: Int,
    val allowUnlockedLp: Boolean,
    val positionCapUsd: Double,
    val cooldowns: List<MintCooldown>,
    val readiness: LiveReadiness?,
    val advice: List<AdviceNote>,
    val positions: List<PositionRow>,
    val events: List<TapeEvent>,
    val closed: List<ClosedTradeRow>,
    val minLiquidityUsd: Double = 0.0,
    val minTokenAgeMin: Double = 0.0,
    val maxTokenAgeMin: Double = 0.0,
    val minHolderCount: Double = 0.0,
    val maxDevHoldingPct: Double = 0.0,
    val maxTradesPerHour: Double = 0.0,
    val dailyMaxLossUsd: Double = 0.0,
    val cooldownHours: Double = 0.0,
    val trailTakeProfit: Boolean = false,
    val trailArmPct: Double = 0.12,
    val trailGapPct: Double = 0.04,
    val autoBuy: Boolean = true,
    val scoutDexscreener: Boolean = true,
    val scoutGecko: Boolean = true,
    val scoutJupiter: Boolean = true,
    val scoutDexpaprika: Boolean = false,
    /** v13.3 keyless Pump.fun API and Raydium LaunchLab (Bonk.fun) listings. */
    val scoutPumpApi: Boolean = true,
    val scoutLaunchLab: Boolean = true,
    val scoutBitquery: Boolean = true,
    val notifyNearMiss: Boolean = true,
    val notifyFills: Boolean = true,
    val notifyStops: Boolean = true,
    val pnlAlertPct: Double = 0.0,
    /** v12 sizing. null = size from the % cap. */
    val positionSizeUsd: Double? = null,
    val maxExposurePct: Double = 1.0,
    val paperResetUsd: Double = 100.0,
    /** v13.2 Position price refresh, ms. */
    val positionRefreshMs: Long = 1_500L,
    /** v13.3 exit slippage tolerance (fraction). Null = entry cap + 3%. */
    val maxExitSlippage: Double? = null,
    val manualMaxUsd: Double = 0.0,
    /** v13.6 which limit set positionCapUsd: "position", "cash" or "exposure", and the sentence. */
    val capBinding: String? = null,
    val capLine: String? = null,
    val exposureUsd: Double = 0.0,
    val watchlist: List<WatchRow> = emptyList(),
    val lastClientCrash: String? = null,
    /** v12.1 per-source Scout status. */
    val feedSources: List<FeedSource> = emptyList(),
    /** v12.1: set only once a source has failed for 2+ minutes straight. */
    val feedBanner: String? = null,
    /** v13.5 live wallet settings (separate from every paper size). */
    val liveTradeUsd: Double = 5.0,
    val liveDailyCapUsd: Double? = null,
    val liveTrailPct: Double = 0.01,
    val wallet: WalletInfo? = null,
    /** v13.7 armed desk: "manual" or "all"; null when not armed. */
    val liveScope: String? = null,
    val liveBook: LiveBookInfo? = null,
    /** v13.9 why LIVE BUY / LIVE SELL do nothing yet ("Live not armed: wallet key missing."). Null when armed. */
    val liveNotArmed: String? = null,
    /** v13.10 live price / volume / change per Tape coin. */
    val tapeQuotes: Map<String, TapeQuote> = emptyMap(),
    /** v13.27 raw sightings on the Tape before enrichment. Empty on an older desk. */
    val rawTape: List<RawTapeRow> = emptyList(),
    /** v13.11 limit / take-profit / stop orders, open first. */
    val orders: List<DeskOrder> = emptyList(),
    /** v13.7 saved toggle: AI auto-buys go live too (default off). */
    val liveAutoBuy: Boolean = false,
    /** v13 hero card. */
    val startingBalanceUsd: Double = 100.0,
    val sessionPnlPct: Double = 0.0,
    val equityPoints: List<EquityPoint> = emptyList(),
    /** v13.23 Helius Sender tip in SOL. Default 0.000005. */
    val senderTipSol: Double = 0.000005,
    val safetyChips: List<SafetyChip> = emptyList(),
    /** v13.24 version string stored with the desk crash. Empty when there is none. */
    val lastClientCrashVersion: String = "",
    val lastClientCrashDismissed: Boolean = false,
    /** Full crash text. Home shows the short brief. */
    val lastClientCrashText: String = "",
    /** v13.29 enrich RPC hostname. Null on an older desk. Off Helius, holder count is the top 20. */
    val enrichHost: String? = null,
    /** v13.30 trading engine and its scorecard. Null on an older desk. */
    val strategy: StrategyView? = null,
    /** v13.33 monotonic snapshot id. 0 on an older desk. */
    val seq: Long = 0,
    /** v13.32 pipeline timings from the desk. Empty on an older desk. */
    val perf: List<PerfRow> = emptyList(),
    /** v13.34 pre-filter line. present is false on an older desk. */
    val prefilter: PrefilterStats = PrefilterStats()
)

/** v13.34 cheap kills, RPC reads not sent, Helius priority-0 depth, enrich latency. */
data class PrefilterStats(
    val present: Boolean = false,
    val kills: Map<String, Int> = emptyMap(),
    val rpcSaved: Int = 0,
    val heliusQueue: Int = 0,
    val enrichP50: Int = 0,
    val enrichP90: Int = 0
)

data class SafetyChip(val mint: String, val safety: String, val bundle: String = "")

/** v13 one point of the equity series (for the hero sparkline). */
data class EquityPoint(val t: Long, val equity: Double)

/** v12.1 one Scout source: live, backoff (with retryAt), down, or off. */
data class FeedSource(
    val id: String,
    val label: String,
    val enabled: Boolean,
    val state: String,
    val detail: String?,
    val retryAt: Long?,
    val reqPerMin: Int,
    val budgetPerMin: Int?,
    val sightingsPerMin: Int
)

/** Same wording as the web Scout status. */
fun feedSourceStateText(src: FeedSource, nowMs: Long): String {
    val detail = src.detail?.takeIf { it.isNotBlank() }
    return when (src.state) {
        "live" -> if (src.id == "pump") "live · websocket" else "live"
        "off" -> if (detail != null) "off · $detail" else "off"
        "down" -> if (detail != null) "down · $detail" else "down"
        "blocked" -> if (detail != null) "blocked · $detail" else "blocked"
        // v13.3 watchdog: connected but silent past 60s. Never shown as live.
        "stale" -> if (detail != null) "stale · $detail" else "stale · reconnecting"
        else -> {
            val left = src.retryAt?.let { kotlin.math.ceil((it - nowMs) / 1000.0).toLong().coerceAtLeast(0L) }
            val wait = if (left != null && left > 0) {
                " · retry in " + if (left >= 60) "${left / 60}:" + "%02d".format(java.util.Locale.US, left % 60) else "${left}s"
            } else ""
            "backing off$wait" + (if (detail != null) " · $detail" else "")
        }
    }
}

fun feedSourceRateText(src: FeedSource): String = when {
    src.id == "pump" -> "${src.sightingsPerMin}/min new"
    src.budgetPerMin == null -> ""
    else -> "${src.reqPerMin}/${src.budgetPerMin} req/min"
}

internal fun parseFeedSources(feed: JSONObject?): List<FeedSource> {
    val rows = feed?.optJSONArray("sources") ?: return emptyList()
    return buildList {
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val id = row.optText("id")
            if (id.isBlank()) continue
            add(
                FeedSource(
                    id = id,
                    label = row.optText("label", id),
                    enabled = row.optBoolean("enabled", true),
                    state = row.optText("state", "live"),
                    detail = row.optText("detail").ifBlank { null },
                    retryAt = if (row.has("retryAt") && !row.isNull("retryAt")) row.optFinite("retryAt").toLong().takeIf { it > 0 } else null,
                    reqPerMin = row.optFinite("reqPerMin").toInt(),
                    budgetPerMin = if (row.has("budgetPerMin") && !row.isNull("budgetPerMin")) row.optFinite("budgetPerMin").toInt() else null,
                    sightingsPerMin = row.optFinite("sightingsPerMin").toInt()
                )
            )
        }
    }
}

/** Same sentence the web desk shows after a manual buy. */
fun formatBuyNotice(ok: Boolean, error: String?, symbol: String?, sizeUsd: Double?, mode: String?, clampedFrom: Double?): String {
    if (!ok) {
        val reason = error?.trim().orEmpty()
        return if (reason.isEmpty()) "Buy refused." else reason
    }
    val size = if (sizeUsd != null && sizeUsd.isFinite()) "$" + "%.2f".format(java.util.Locale.US, sizeUsd) else "the filled size"
    val name = symbol?.trim().takeUnless { it.isNullOrEmpty() } ?: "the mint"
    val lane = if (mode == "live") "live" else "paper"
    val clamp = if (clampedFrom != null && sizeUsd != null && clampedFrom > sizeUsd + 0.001) {
        " Requested $" + "%.2f".format(java.util.Locale.US, clampedFrom) + " was cut to the position cap."
    } else {
        ""
    }
    return "Bought $name for $size ($lane).$clamp"
}

/** Missing, null, and non-finite JSON numbers become the fallback. optDouble would hand back NaN. */
/** Null when the key is missing, JSON null, or not a finite number. */
fun JSONObject.optNullableFinite(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    val number = when (val raw = opt(key)) {
        is Number -> raw.toDouble()
        is String -> raw.toDoubleOrNull()
        else -> null
    }
    return number?.takeIf { it.isFinite() }
}

/** Sparkline points. Null when the payload omitted `marks` (keep the previous series). */
fun parsePricePoints(row: JSONObject): List<PricePoint>? {
    if (!row.has("marks")) return null
    if (row.isNull("marks")) return emptyList()
    val arr = row.optJSONArray("marks") ?: return emptyList()
    return buildList {
        for (i in 0 until arr.length()) {
            val point = arr.optJSONObject(i) ?: continue
            val price = point.optDouble("priceUsd", Double.NaN)
            val t = point.optDouble("t", Double.NaN)
            if (price.isFinite() && price > 0.0 && t.isFinite()) add(PricePoint(t.toLong(), price))
        }
    }
}

fun JSONObject.optFinite(key: String, fallback: Double = 0.0): Double {
    if (!has(key) || isNull(key)) return fallback
    val number = when (val raw = opt(key)) {
        is Number -> raw.toDouble()
        is String -> raw.toDoubleOrNull()
        else -> null
    }
    return if (number != null && number.isFinite()) number else fallback
}

/** JSON null is not the word "null", and a missing string is the fallback. */
fun JSONObject.optText(key: String, fallback: String = ""): String {
    if (!has(key) || isNull(key)) return fallback
    val raw = opt(key)
    val text = when (raw) {
        is String -> raw
        is Number -> raw.toString()
        else -> return fallback
    }
    return text.ifBlank { fallback }
}

fun formatUsd(n: Double?): String {
    val value = n?.takeIf { it.isFinite() } ?: 0.0
    return java.text.NumberFormat.getCurrencyInstance(java.util.Locale.US).format(value)
}

data class RecapView(
    val text: String,
    val closedCount: Int,
    val closed: List<ClosedTradeRow>,
    val startingEquity: Double,
    val pnlUsd: Double
)

/**
 * /api/recap. closed may be null or empty. closedCount may be missing.
 * A bad body returns null instead of throwing on the caller thread.
 */
fun parseRecap(raw: String): RecapView? {
    val root = try {
        JSONObject(raw)
    } catch (_: Throwable) {
        return null
    }
    return try {
        val rows = root.optJSONArray("closed")
        val closedIds = HashSet<String>()
        val closed = buildList {
            if (rows != null) {
                for (i in 0 until rows.length()) {
                    val row = rows.optJSONObject(i) ?: continue
                    val trade = closedTrade(row, i)
                    add(trade.copy(id = freshId(closedIds, trade.id)))
                }
            }
        }
        val counted = if (root.has("closedCount") && !root.isNull("closedCount")) root.optInt("closedCount", closed.size) else closed.size
        RecapView(
            text = root.optText("text").ifBlank { "No recap text." },
            closedCount = counted.coerceAtLeast(closed.size),
            closed = closed,
            startingEquity = root.optFinite("startingEquity"),
            pnlUsd = root.optFinite("pnlUsd")
        )
    } catch (_: Throwable) {
        null
    }
}

private fun freshId(seen: MutableSet<String>, base: String): String {
    if (seen.add(base)) return base
    var n = 2
    while (!seen.add("$base#$n")) n += 1
    return "$base#$n"
}

private fun closedTrade(row: JSONObject, index: Int): ClosedTradeRow {
    return ClosedTradeRow(
        id = row.optText("id").ifBlank { "trade-$index" },
        symbol = row.optText("symbol", "—"),
        exitCode = row.optText("exitCode"),
        closedAt = row.optFinite("closedAt").toLong(),
        entryPrice = row.optFinite("entryPrice"),
        exitPrice = row.optFinite("exitPrice"),
        pnlUsd = row.optFinite("pnlUsd")
    )
}

fun parseDeskPayload(raw: String): DeskSnapshot? {
    return try {
        parseDeskPayloadBody(raw)
    } catch (_: Throwable) {
        null
    }
}

private fun parseDeskPayloadBody(raw: String): DeskSnapshot? {
    val receivedAt = System.currentTimeMillis()
    val root = JSONObject(raw)
    val data = when {
        root.has("equityUsd") -> root
        root.optJSONObject("data") != null -> root.getJSONObject("data")
        else -> return null
    }
    if (!data.has("equityUsd")) return null
    val rules = data.optJSONObject("rules")
    val prefs = data.optJSONObject("prefs")
    val ready = data.optJSONObject("readiness")
    val advice = data.optJSONArray("advice")
    val positions = data.optJSONArray("positions")
    val events = data.optJSONArray("events")
    val adviceIds = HashSet<String>()
    val notes = buildList {
        if (advice != null) {
            for (i in 0 until advice.length()) {
                val row = advice.optJSONObject(i) ?: continue
                add(
                    AdviceNote(
                        id = freshId(adviceIds, row.optText("id").ifBlank { "advice-$i" }),
                        stance = row.optText("stance", "watch"),
                        text = row.optText("text"),
                        symbol = row.optText("symbol").ifBlank { null },
                        mint = row.optText("mint").ifBlank { null },
                        code = row.optText("code").ifBlank { null },
                        score = if (row.has("score") && !row.isNull("score")) row.optFinite("score", Double.NaN).takeIf { it.isFinite() } else null
                    )
                )
            }
        }
    }
    val book = parsePositionRows(positions, receivedAt, live = false)
    val bans = buildList {
        val rows = data.optJSONArray("cooldowns")
        if (rows != null) {
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                val mint = row.optText("mint")
                if (mint.isBlank()) continue
                add(
                    MintCooldown(
                        mint = mint,
                        until = row.optFinite("until").toLong(),
                        minutesLeft = row.optFinite("minutesLeft").toInt()
                    )
                )
            }
        }
    }
    val closedIds = HashSet<String>()
    val closedRows = buildList {
        val rows = data.optJSONArray("closed")
        if (rows != null) {
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                val trade = closedTrade(row, i)
                add(trade.copy(id = freshId(closedIds, trade.id)))
            }
        }
    }
    val eventIds = HashSet<String>()
    val tape = buildList {
        if (events != null) {
            for (i in 0 until events.length()) {
                val row = events.optJSONObject(i) ?: continue
                val id = freshId(eventIds, row.optText("id").ifBlank { "event-$i-${row.optFinite("ts").toLong()}" })
                add(
                    TapeEvent(
                        id = id,
                        ts = row.optFinite("ts").toLong(),
                        stage = row.optText("stage", "system"),
                        kind = row.optText("kind", "info"),
                        message = row.optText("message"),
                        code = row.optText("code").ifBlank { null },
                        mint = row.optText("mint").ifBlank { null },
                        symbol = row.optText("symbol").ifBlank { null },
                        detail = row.optText("detail").ifBlank { null }
                    )
                )
            }
        }
    }
    val equityUsd = data.optFinite("equityUsd")
    val cashUsd = data.optFinite("cashUsd")
    val feed = data.optJSONObject("feed")
    val equityJson = data.optJSONArray("equity")
    val equitySeries = buildList {
        if (equityJson != null) {
            // Keep at most ~240 points so the sparkline stays cheap on the phone.
            val stride = (equityJson.length() / 240).coerceAtLeast(1)
            var i = 0
            while (i < equityJson.length()) {
                val row = equityJson.optJSONObject(i)
                if (row != null) {
                    val eq = row.optFinite("equity", Double.NaN)
                    if (eq.isFinite()) add(EquityPoint(row.optFinite("t").toLong(), eq))
                }
                i += stride
            }
            val last = equityJson.optJSONObject(equityJson.length() - 1)
            if (last != null && (equityJson.length() - 1) % stride != 0) {
                val eq = last.optFinite("equity", Double.NaN)
                if (eq.isFinite()) add(EquityPoint(last.optFinite("t").toLong(), eq))
            }
        }
    }
    return DeskSnapshot(
        liveTradeUsd = (prefs?.optFinite("liveTradeUsd", 5.0) ?: 5.0).takeIf { it > 0 } ?: 5.0,
        liveDailyCapUsd = prefs?.let { row -> if (!row.has("liveDailyCapUsd") || row.isNull("liveDailyCapUsd")) null else row.optFinite("liveDailyCapUsd", Double.NaN).takeIf { it.isFinite() && it > 0 } },
        liveTrailPct = (prefs?.optFinite("liveTrailPct", 0.01) ?: 0.01).let { if (it >= 0.5) it / 100 else it }.coerceIn(0.005, 0.2),
        wallet = parseWallet(data.optJSONObject("wallet")),
        liveScope = data.optText("liveScope").ifBlank { null }?.takeIf { it != "null" },
        liveBook = if (data.isNull("liveBook")) null else parseLiveBook(data.optJSONObject("liveBook"), receivedAt),
        liveNotArmed = if (data.isNull("liveNotArmed")) null else data.optText("liveNotArmed").ifBlank { null },
        tapeQuotes = parseTapeQuotes(data.optJSONObject("tapeQuotes")),
        rawTape = parseRawTape(data.optJSONArray("rawTape")),
        orders = parseOrders(data.optJSONArray("orders")),
        liveAutoBuy = prefs?.optBoolean("liveAutoBuy", false) ?: false,
        startingBalanceUsd = data.optFinite("startingBalanceUsd", 100.0),
        sessionPnlPct = data.optFinite("sessionPnlPct"),
        equityPoints = equitySeries,
        feedSources = parseFeedSources(feed),
        feedBanner = feed?.optText("lastError")?.ifBlank { null },
        mode = data.optText("mode", "paper"),
        cashUsd = cashUsd,
        equityUsd = equityUsd,
        sessionPnlUsd = data.optFinite("sessionPnlUsd"),
        minVolume1hUsd = rules?.optFinite("minVolume1hUsd", 10_000.0) ?: 10_000.0,
        analystMinScore = rules?.optFinite("analystMinScore", 0.5) ?: 0.5,
        volumeBoost = rules?.takeIf { it.has("volumeBoost") }?.optFinite("volumeBoost", 0.5),
        maxTop10Pct = rules?.optFinite("maxTop10Pct", 0.35) ?: 0.35,
        maxPositionPct = rules?.optFinite("maxPositionPct", 0.08) ?: 0.08,
        stopLossPct = rules?.optFinite("stopLossPct", 0.06) ?: 0.06,
        maxEntrySlippage = (rules?.optFinite("maxEntrySlippage", 0.03) ?: 0.03).let { if (it > 1) it / 100 else it }.coerceIn(0.005, 0.5),
        defaultBuyUsd = prefs?.let { row -> if (!row.has("defaultBuyUsd") || row.isNull("defaultBuyUsd")) null else row.optFinite("defaultBuyUsd", Double.NaN).takeIf { it.isFinite() && it > 0 } },
        maxOpenPositions = prefs?.optInt("maxOpenPositions", 12) ?: 12,
        allowUnlockedLp = prefs?.optBoolean("allowUnlockedLp", true) ?: true,
        cooldowns = bans,
        positionCapUsd = when {
            data.has("positionCapUsd") && !data.isNull("positionCapUsd") -> data.optFinite("positionCapUsd")
            else -> {
                val pct = (rules?.optFinite("maxPositionPct", 0.08) ?: 0.08).let { if (it > 1) it / 100 else it }.coerceAtMost(0.08)
                val cap = kotlin.math.floor(equityUsd * pct * 100.0) / 100.0
                val cash = kotlin.math.floor(cashUsd.coerceAtLeast(0.0) * 100.0) / 100.0
                kotlin.math.min(cap, cash)
            }
        },
        readiness = ready?.let { row ->
            val linesJson = row.optJSONArray("lines")
            LiveReadiness(
                mode = row.optText("mode", "paper"),
                liveTradingFlag = row.optBoolean("liveTradingFlag"),
                keypairPresent = row.optBoolean("keypairPresent"),
                walletPublicKey = row.optText("walletPublicKey").ifBlank { null },
                rpcPresent = row.optBoolean("rpcPresent"),
                operatorReady = row.optBoolean("operatorReady"),
                lines = buildList {
                    if (linesJson != null) {
                        for (i in 0 until linesJson.length()) {
                            if (linesJson.isNull(i)) continue
                            val line = linesJson.optString(i)
                            if (line.isNotBlank() && line != "null") add(line)
                        }
                    }
                }
            )
        },
        advice = notes,
        positions = book,
        events = tape,
        closed = closedRows,
        minLiquidityUsd = prefs?.optFinite("minLiquidityUsd") ?: 0.0,
        minTokenAgeMin = prefs?.optFinite("minTokenAgeMin") ?: 0.0,
        maxTokenAgeMin = prefs?.optFinite("maxTokenAgeMin") ?: 0.0,
        minHolderCount = prefs?.optFinite("minHolderCount") ?: 0.0,
        maxDevHoldingPct = prefs?.optFinite("maxDevHoldingPct") ?: 0.0,
        maxTradesPerHour = prefs?.optFinite("maxTradesPerHour") ?: 0.0,
        dailyMaxLossUsd = prefs?.optFinite("dailyMaxLossUsd") ?: 0.0,
        cooldownHours = prefs?.optFinite("cooldownHours", 0.0) ?: 0.0,
        trailTakeProfit = prefs?.optBoolean("trailTakeProfit", false) ?: false,
        trailArmPct = rules?.optFinite("trailArmPct", 0.12) ?: 0.12,
        trailGapPct = rules?.optFinite("trailGapPct", 0.04) ?: 0.04,
        autoBuy = prefs?.optBoolean("autoBuy", true) ?: true,
        scoutDexscreener = prefs?.optBoolean("scoutDexscreener", true) ?: true,
        scoutGecko = prefs?.optBoolean("scoutGecko", true) ?: true,
        scoutJupiter = prefs?.optBoolean("scoutJupiter", true) ?: true,
        scoutDexpaprika = prefs?.optBoolean("scoutDexpaprika", false) ?: false,
        scoutPumpApi = prefs?.optBoolean("scoutPumpApi", true) ?: true,
        scoutLaunchLab = prefs?.optBoolean("scoutLaunchLab", true) ?: true,
        scoutBitquery = prefs?.optBoolean("scoutBitquery", true) ?: true,
        notifyNearMiss = prefs?.optBoolean("notifyNearMiss", true) ?: true,
        notifyFills = prefs?.optBoolean("notifyFills", true) ?: true,
        notifyStops = prefs?.optBoolean("notifyStops", true) ?: true,
        pnlAlertPct = prefs?.optFinite("pnlAlertPct") ?: 0.0,
        positionSizeUsd = prefs?.let { row -> if (!row.has("positionSizeUsd") || row.isNull("positionSizeUsd")) null else row.optFinite("positionSizeUsd", Double.NaN).takeIf { it.isFinite() && it > 0 } },
        maxExposurePct = (prefs?.optFinite("maxExposurePct", 1.0) ?: 1.0).let { if (it > 1) it / 100 else it }.coerceIn(0.1, 1.0),
        paperResetUsd = (prefs?.optFinite("paperResetUsd", 100.0) ?: 100.0).coerceIn(100.0, 10_000.0),
        positionRefreshMs = (prefs?.optFinite("positionRefreshMs", 1_500.0) ?: 1_500.0).toLong().coerceIn(1_000L, 10_000L),
        maxExitSlippage = prefs?.let { row -> if (!row.has("maxExitSlippage") || row.isNull("maxExitSlippage")) null else row.optFinite("maxExitSlippage", Double.NaN).takeIf { it.isFinite() && it > 0 }?.let { if (it > 1) it / 100 else it }?.coerceIn(0.005, 0.5) },
        manualMaxUsd = data.optFinite("manualMaxUsd"),
        capBinding = data.optJSONObject("capWhy")?.optText("binding")?.ifBlank { null },
        capLine = data.optJSONObject("capWhy")?.optText("line")?.ifBlank { null },
        exposureUsd = data.optFinite("exposureUsd"),
        watchlist = parseWatchRows(data.optJSONArray("watchlist")),
        lastClientCrash = data.optJSONObject("lastClientCrash")?.let { c -> c.optText("brief").ifBlank { null } },
        lastClientCrashVersion = data.optJSONObject("lastClientCrash")?.optText("version") ?: "",
        lastClientCrashDismissed = data.optJSONObject("lastClientCrash")?.optBoolean("dismissed", false) ?: false,
        lastClientCrashText = data.optJSONObject("lastClientCrash")?.let { c -> c.optText("text").ifBlank { c.optText("brief") } } ?: "",
        senderTipSol = (prefs?.optFinite("senderTipSol", 0.000005) ?: 0.000005).coerceAtLeast(0.000005),
        safetyChips = parseSafetyChips(data.optJSONArray("safetyChips")),
        enrichHost = data.optJSONObject("enrich")?.optText("host")?.ifBlank { null },
        strategy = Strategy.parse(data.optJSONObject("strategy")),
        seq = data.optLong("seq", 0L),
        perf = Perf.parse(data.optJSONObject("perf")),
        prefilter = parsePrefilter(data.optJSONObject("prefilter"))
    )
}

private fun parsePrefilter(row: JSONObject?): PrefilterStats {
    if (row == null) return PrefilterStats()
    val killsJson = row.optJSONObject("kills")
    val kills = mutableMapOf<String, Int>()
    if (killsJson != null) {
        val keys = killsJson.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            kills[key] = killsJson.optInt(key, 0)
        }
    }
    val enrich = row.optJSONObject("enrich")
    return PrefilterStats(
        present = true,
        kills = kills,
        rpcSaved = row.optInt("rpcSaved", 0),
        heliusQueue = row.optInt("heliusQueue", 0),
        enrichP50 = enrich?.optInt("p50Ms", 0) ?: 0,
        enrichP90 = enrich?.optInt("p90Ms", 0) ?: 0
    )
}

private fun parseRawTape(rows: org.json.JSONArray?): List<RawTapeRow> {
    if (rows == null) return emptyList()
    return buildList {
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val mint = row.optText("mint")
            if (mint.isBlank()) continue
            fun optPos(key: String): Double? = if (!row.has(key) || row.isNull(key)) null else row.optFinite(key, Double.NaN).takeIf { it > 0 && it.isFinite() }
            add(
                RawTapeRow(
                    mint = mint,
                    symbol = row.optText("symbol").ifBlank { mint.take(4) },
                    name = row.optText("name"),
                    source = row.optText("source", "scout"),
                    seenAt = row.optFinite("seenAt").toLong(),
                    priceUsd = optPos("priceUsd"),
                    volume1hUsd = optPos("volume1hUsd"),
                    liquidityUsd = optPos("liquidityUsd"),
                    marketCapUsd = optPos("marketCapUsd"),
                    enrich = row.optText("enrich", "pending")
                )
            )
        }
    }
}

private fun parseSafetyChips(rows: org.json.JSONArray?): List<SafetyChip> {
    if (rows == null) return emptyList()
    return buildList {
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val mint = row.optText("mint")
            if (mint.isBlank()) continue
            add(SafetyChip(mint, row.optText("safety", "Unknown"), row.optText("bundle")))
        }
    }
}

/** Position cards from a snapshot array (the paper book's `positions`, or v13.7 `liveBook.positions`). */
internal fun parsePositionRows(positions: org.json.JSONArray?, receivedAt: Long, live: Boolean): List<PositionRow> {
    val mintIds = HashSet<String>()
    return buildList {
        if (positions != null) {
            for (i in 0 until positions.length()) {
                val row = positions.optJSONObject(i) ?: continue
                add(
                    PositionRow(
                        mint = freshId(mintIds, row.optText("mint").ifBlank { "mint-$i" }),
                        symbol = row.optText("symbol", "—"),
                        pnlUsd = row.optFinite("pnlUsd"),
                        pnlPct = row.optFinite("pnlPct"),
                        markPrice = row.optFinite("markPrice"),
                        stopPrice = row.optFinite("stopPrice"),
                        entryPrice = row.optFinite("entryPrice"),
                        score = row.optFinite("score"),
                        source = row.optText("source"),
                        entry = row.optText("entry", "analyst"),
                        lpUnlocked = row.optBoolean("lpUnlocked"),
                        markAgeMs = row.optFinite("markAgeMs").toLong().coerceAtLeast(0L),
                        markLocalAt = receivedAt - row.optFinite("markAgeMs").toLong().coerceAtLeast(0L),
                        markFeed = row.optText("markFeed"),
                        costUsd = row.optFinite("costUsd"),
                        marketValueUsd = row.optFinite("marketValueUsd"),
                        openedAt = row.optFinite("openedAt").toLong(),
                        tag = row.optText("tag").ifBlank { null },
                        peakPrice = row.optFinite("peakPrice"),
                        live = live || row.optText("book") == "live",
                        netPnlUsd = row.optNullableFinite("netPnlUsd"),
                        netPnlPct = row.optNullableFinite("netPnlPct"),
                        exitSlippage = row.optNullableFinite("exitSlippage"),
                        marks = parsePricePoints(row) ?: emptyList(),
                        safetyChip = row.optText("safetyChip"),
                        bundleChip = row.optText("bundleChip"),
                        liquidityNote = row.optText("liquidityNote")
                    )
                )
            }
        }
    }
}

/** v13.7 the live book from /api/state `liveBook`. Null when the desk is not armed (or older). */
internal fun parseLiveBook(row: JSONObject?, receivedAt: Long): LiveBookInfo? {
    if (row == null) return null
    return LiveBookInfo(
        scope = row.optText("scope", "manual"),
        line = row.optText("line"),
        cashUsd = row.optFinite("cashUsd"),
        cashKnown = if (row.has("cashKnown")) row.optBoolean("cashKnown") else true,
        balanceError = row.optText("balanceError").ifBlank { null }?.takeIf { it != "null" },
        equityUsd = row.optFinite("equityUsd"),
        openPnlUsd = row.optFinite("openPnlUsd"),
        positions = parsePositionRows(row.optJSONArray("positions"), receivedAt, live = true),
        tradeUsd = row.optFinite("tradeUsd", 5.0),
        trailPct = row.optFinite("trailPct", 0.05),
        dailyCapUsd = if (!row.has("dailyCapUsd") || row.isNull("dailyCapUsd")) null else row.optFinite("dailyCapUsd", Double.NaN).takeIf { it.isFinite() && it > 0 },
        equityPoints = parseEquityPoints(row.optJSONArray("equity")),
        startingUsd = row.optFinite("startingUsd"),
        pnlUsd = row.optFinite("pnlUsd")
    )
}

/** An `equity` array of {t, equity} rows. A row without a finite equity is dropped, never drawn as 0. */
internal fun parseEquityPoints(rows: JSONArray?): List<EquityPoint> = buildList {
    if (rows == null) return@buildList
    for (i in 0 until rows.length()) {
        val row = rows.optJSONObject(i) ?: continue
        val eq = row.optFinite("equity", Double.NaN)
        val t = row.optFinite("t", Double.NaN)
        if (eq.isFinite() && t.isFinite() && t > 0) add(EquityPoint(t.toLong(), eq))
    }
}

/** v13.5 wallet card from /api/state `wallet`. Null on a desk older than v13.5. */
internal fun parseWallet(row: JSONObject?): WalletInfo? {
    if (row == null) return null
    fun optNum(key: String): Double? = if (!row.has(key) || row.isNull(key)) null else row.optFinite(key, Double.NaN).takeIf { it.isFinite() }
    return WalletInfo(
        keyLoaded = row.optBoolean("keyLoaded"),
        keySource = row.optText("keySource").ifBlank { null }?.takeIf { it != "null" },
        keyInvalid = row.optBoolean("keyInvalid"),
        publicKey = row.optText("publicKey").ifBlank { null }?.takeIf { it != "null" },
        solBalance = optNum("solBalance"),
        usdcBalance = optNum("usdcBalance"),
        solPriceUsd = optNum("solPriceUsd"),
        balanceAt = optNum("balanceAt")?.toLong(),
        balanceError = row.optText("balanceError").ifBlank { null }?.takeIf { it != "null" },
        live = row.optBoolean("live"),
        liveRequested = row.optBoolean("liveRequested"),
        rpcPublic = row.optBoolean("rpcPublic"),
        liveSpentTodayUsd = optNum("liveSpentTodayUsd") ?: 0.0,
        minFeeSol = optNum("minFeeSol") ?: 0.005,
        liveScopeLine = row.optText("liveScopeLine").ifBlank { null }?.takeIf { it != "null" }
    )
}

/** v13.10 `tapeQuotes` from /api/state. A price of 0 or junk is dropped (never shown as 0). */
internal fun parseTapeQuotes(obj: JSONObject?): Map<String, TapeQuote> {
    if (obj == null) return emptyMap()
    val out = HashMap<String, TapeQuote>()
    fun JSONObject.num(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key, Double.NaN).takeIf { it.isFinite() }
    for (mint in obj.keys()) {
        val q = obj.optJSONObject(mint) ?: continue
        out[mint] = TapeQuote(
            priceUsd = q.num("priceUsd")?.takeIf { it > 0 },
            vol1hUsd = q.num("vol1hUsd")?.takeIf { it >= 0 },
            vol5mUsd = q.num("vol5mUsd")?.takeIf { it >= 0 },
            change1hPct = q.num("change1hPct"),
            source = if (q.isNull("source")) null else q.optString("source").ifBlank { null },
            at = q.optLong("at"),
            why = if (q.isNull("why")) null else q.optString("why").ifBlank { null }
        )
    }
    return out
}

/** v13.11 one limit buy / take profit / stop from /api/state `orders`. */
data class DeskOrder(
    val id: String,
    val book: String,
    val side: String,
    val mint: String,
    val symbol: String,
    val triggerPrice: Double,
    val fraction: Double?,
    val sizeUsd: Double?,
    val status: String,
    val note: String?,
    val waiting: String?,
    val markUsd: Double?,
    val distancePct: Double?,
    val text: String
) {
    val isOpen: Boolean get() = status == "open" || status == "working"
    val live: Boolean get() = book == "live"
}

/** Orders with no real trigger price are dropped (never shown as 0). */
internal fun parseOrders(rows: JSONArray?): List<DeskOrder> {
    if (rows == null) return emptyList()
    val out = ArrayList<DeskOrder>()
    fun JSONObject.num(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key, Double.NaN).takeIf { it.isFinite() }
    fun JSONObject.str(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifBlank { null }
    for (i in 0 until rows.length()) {
        val o = rows.optJSONObject(i) ?: continue
        val trigger = o.num("triggerPrice")?.takeIf { it > 0 } ?: continue
        val id = o.str("id") ?: continue
        out += DeskOrder(
            id = id,
            book = if (o.str("book") == "live") "live" else "paper",
            side = o.str("side") ?: continue,
            mint = o.str("mint") ?: continue,
            symbol = o.str("symbol") ?: "",
            triggerPrice = trigger,
            fraction = o.num("fraction"),
            sizeUsd = o.num("sizeUsd"),
            status = o.str("status") ?: "open",
            note = o.str("note"),
            waiting = o.str("waiting"),
            markUsd = o.num("markUsd")?.takeIf { it > 0 },
            distancePct = o.num("distancePct"),
            text = o.str("text") ?: ""
        )
    }
    return out
}
