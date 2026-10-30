package com.dirk.nightdesk

import org.json.JSONObject

data class AdviceNote(
    val id: String,
    val stance: String,
    val text: String,
    val symbol: String?,
    val mint: String? = null,
    val code: String? = null,
    val score: Double? = null
)

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
    val openedAt: Long = 0L
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
    val symbol: String?
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

data class MintCooldown(val mint: String, val until: Long, val minutesLeft: Int)

data class DeskSnapshot(
    val mode: String,
    val cashUsd: Double,
    val equityUsd: Double,
    val sessionPnlUsd: Double,
    val minVolume1hUsd: Double,
    val analystMinScore: Double,
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
    val cooldownHours: Double = 6.0,
    val trailTakeProfit: Boolean = false,
    val trailArmPct: Double = 0.12,
    val trailGapPct: Double = 0.04,
    val autoBuy: Boolean = true,
    val scoutDexscreener: Boolean = true,
    val scoutGecko: Boolean = true,
    val scoutJupiter: Boolean = true,
    val scoutDexpaprika: Boolean = false,
    val scoutBitquery: Boolean = true,
    val notifyNearMiss: Boolean = true,
    val notifyFills: Boolean = true,
    val notifyStops: Boolean = true,
    val pnlAlertPct: Double = 0.0
)

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
    val mintIds = HashSet<String>()
    val book = buildList {
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
                        costUsd = row.optFinite("costUsd"),
                        marketValueUsd = row.optFinite("marketValueUsd"),
                        openedAt = row.optFinite("openedAt").toLong()
                    )
                )
            }
        }
    }
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
                        symbol = row.optText("symbol").ifBlank { null }
                    )
                )
            }
        }
    }
    val equityUsd = data.optFinite("equityUsd")
    val cashUsd = data.optFinite("cashUsd")
    return DeskSnapshot(
        mode = data.optText("mode", "paper"),
        cashUsd = cashUsd,
        equityUsd = equityUsd,
        sessionPnlUsd = data.optFinite("sessionPnlUsd"),
        minVolume1hUsd = rules?.optFinite("minVolume1hUsd", 10_000.0) ?: 10_000.0,
        analystMinScore = rules?.optFinite("analystMinScore", 0.5) ?: 0.5,
        maxTop10Pct = rules?.optFinite("maxTop10Pct", 0.35) ?: 0.35,
        maxPositionPct = rules?.optFinite("maxPositionPct", 0.08) ?: 0.08,
        stopLossPct = rules?.optFinite("stopLossPct", 0.06) ?: 0.06,
        maxEntrySlippage = (rules?.optFinite("maxEntrySlippage", 0.03) ?: 0.03).let { if (it > 1) it / 100 else it }.coerceIn(0.005, 0.03),
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
        cooldownHours = prefs?.optFinite("cooldownHours", 6.0) ?: 6.0,
        trailTakeProfit = prefs?.optBoolean("trailTakeProfit", false) ?: false,
        trailArmPct = rules?.optFinite("trailArmPct", 0.12) ?: 0.12,
        trailGapPct = rules?.optFinite("trailGapPct", 0.04) ?: 0.04,
        autoBuy = prefs?.optBoolean("autoBuy", true) ?: true,
        scoutDexscreener = prefs?.optBoolean("scoutDexscreener", true) ?: true,
        scoutGecko = prefs?.optBoolean("scoutGecko", true) ?: true,
        scoutJupiter = prefs?.optBoolean("scoutJupiter", true) ?: true,
        scoutDexpaprika = prefs?.optBoolean("scoutDexpaprika", false) ?: false,
        scoutBitquery = prefs?.optBoolean("scoutBitquery", true) ?: true,
        notifyNearMiss = prefs?.optBoolean("notifyNearMiss", true) ?: true,
        notifyFills = prefs?.optBoolean("notifyFills", true) ?: true,
        notifyStops = prefs?.optBoolean("notifyStops", true) ?: true,
        pnlAlertPct = prefs?.optFinite("pnlAlertPct") ?: 0.0
    )
}
