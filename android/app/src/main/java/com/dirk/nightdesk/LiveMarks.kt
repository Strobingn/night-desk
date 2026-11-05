package com.dirk.nightdesk

import org.json.JSONObject

/**
 * v13.2 live position marks. The desk pushes a small {"type":"marks"} message whenever an
 * open position gets a new mark (about every 1.5 s). It is merged into the last full
 * snapshot instead of waiting for the next ~80 KB one.
 */
data class MarkDelta(
    val mint: String,
    val markPrice: Double,
    val marketValueUsd: Double,
    val pnlUsd: Double,
    val pnlPct: Double,
    val stopPrice: Double,
    val peakPrice: Double,
    val markAgeMs: Long,
    val markFeed: String,
    val netPnlUsd: Double? = null,
    val netPnlPct: Double? = null,
    val exitSlippage: Double? = null,
    /** True when this delta included netPnlUsd (including JSON null). */
    val netKnown: Boolean = false,
    /** Null when this delta omitted marks. */
    val marks: List<PricePoint>? = null
)

data class MarksMessage(
    val cashUsd: Double,
    val equityUsd: Double,
    val positions: List<MarkDelta>,
    /** v13.7 live book marks (armed desk only). */
    val livePositions: List<MarkDelta> = emptyList(),
    val liveCashUsd: Double = Double.NaN,
    val liveEquityUsd: Double = Double.NaN
)

/** Amber past 10 s, red past 30 s. */
const val MARK_AMBER_MS = 10_000L
const val MARK_RED_MS = 30_000L

enum class MarkFreshness { FRESH, AMBER, RED }

fun markFreshness(ageMs: Long): MarkFreshness = when {
    ageMs > MARK_RED_MS -> MarkFreshness.RED
    ageMs > MARK_AMBER_MS -> MarkFreshness.AMBER
    else -> MarkFreshness.FRESH
}

fun updatedLabel(ageMs: Long): String {
    val ms = ageMs.coerceAtLeast(0L)
    return when {
        ms < 1_000 -> "updated just now"
        ms < 60_000 -> "updated ${ms / 1_000}s ago"
        ms < 3_600_000 -> "updated ${ms / 60_000}m ago"
        else -> "updated ${ms / 3_600_000}h ago"
    }
}

/** Short source name shown after the age. */
fun feedLabel(feed: String): String = when (feed) {
    "chain" -> "pool"
    "dexscreener" -> "DexScreener"
    "jupiter" -> "Jupiter"
    "pumpfun", "scout" -> "Pump"
    "" -> ""
    else -> feed
}

/** v13.8 card line: source first, then a precise age ("on-chain · 0.3s", "DexScreener · 12s"). */
fun sourceAgeLabel(feed: String, ageMs: Long): String {
    val src = if (feed == "chain") "on-chain" else feedLabel(feed).ifEmpty { "mark" }
    val ms = ageMs.coerceAtLeast(0L)
    val age = when {
        ms < 10_000 -> "%.1fs".format(java.util.Locale.US, ms / 1_000.0)
        ms < 60_000 -> "${ms / 1_000}s"
        ms < 3_600_000 -> "${ms / 60_000}m"
        else -> "${ms / 3_600_000}h"
    }
    return "$src · $age"
}

/** Age right now, from the local time the mark was taken (no server clock needed). */
fun liveAgeMs(row: PositionRow, nowMs: Long): Long =
    if (row.markLocalAt > 0L) (nowMs - row.markLocalAt).coerceAtLeast(0L) else row.markAgeMs

fun parseMarksMessage(raw: String): MarksMessage? = runCatching {
    val root = JSONObject(raw)
    if (root.optString("type") != "marks") return null
    val data = root.optJSONObject("data") ?: return null
    val rows = data.optJSONArray("positions") ?: return null
    val live = data.optJSONObject("live")
    MarksMessage(
        cashUsd = data.optDouble("cashUsd", Double.NaN),
        equityUsd = data.optDouble("equityUsd", Double.NaN),
        positions = parseMarkRows(rows),
        livePositions = parseMarkRows(live?.optJSONArray("positions")),
        liveCashUsd = live?.optDouble("cashUsd", Double.NaN) ?: Double.NaN,
        liveEquityUsd = live?.optDouble("equityUsd", Double.NaN) ?: Double.NaN
    )
}.getOrNull()

private fun parseMarkRows(rows: org.json.JSONArray?): List<MarkDelta> {
    if (rows == null) return emptyList()
    return buildList {
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val mint = row.optString("mint")
            val mark = row.optDouble("markPrice", Double.NaN)
            // Fail closed: a delta without a usable mark is ignored, the card keeps its last good one.
            if (mint.isBlank() || !mark.isFinite() || mark <= 0.0) continue
            add(
                MarkDelta(
                    mint = mint,
                    markPrice = mark,
                    marketValueUsd = row.optDouble("marketValueUsd", Double.NaN),
                    pnlUsd = row.optDouble("pnlUsd", Double.NaN),
                    pnlPct = row.optDouble("pnlPct", Double.NaN),
                    stopPrice = row.optDouble("stopPrice", Double.NaN),
                    peakPrice = row.optDouble("peakPrice", Double.NaN),
                    markAgeMs = row.optDouble("markAgeMs", 0.0).let { if (it.isFinite()) it.toLong().coerceAtLeast(0L) else 0L },
                    markFeed = row.optString("markFeed"),
                    netPnlUsd = row.optNullableFinite("netPnlUsd"),
                    netPnlPct = row.optNullableFinite("netPnlPct"),
                    exitSlippage = row.optNullableFinite("exitSlippage"),
                    netKnown = row.has("netPnlUsd"),
                    marks = parsePricePoints(row)
                )
            )
        }
    }
}

private fun Double.or(fallback: Double): Double = if (isFinite()) this else fallback

/** Merges a marks message into the last snapshot. Unknown mints are ignored; nothing is removed. */
fun DeskSnapshot.withMarks(msg: MarksMessage, receivedAt: Long = System.currentTimeMillis()): DeskSnapshot {
    val (merged, touched) = mergeMarkRows(positions, msg.positions, receivedAt)
    val lb = liveBook
    val (liveMerged, liveTouched) = if (lb != null) mergeMarkRows(lb.positions, msg.livePositions, receivedAt) else Pair(emptyList<PositionRow>(), false)
    if (!touched && !liveTouched) return this
    return copy(
        positions = merged,
        cashUsd = if (touched) msg.cashUsd.or(cashUsd) else cashUsd,
        equityUsd = if (touched) msg.equityUsd.or(equityUsd) else equityUsd,
        liveBook = if (lb != null && liveTouched) {
            lb.copy(
                positions = liveMerged,
                cashUsd = msg.liveCashUsd.or(lb.cashUsd),
                equityUsd = msg.liveEquityUsd.or(lb.equityUsd),
                openPnlUsd = liveMerged.sumOf { it.pnlUsd }
            )
        } else lb
    )
}

private fun mergeMarkRows(rows: List<PositionRow>, deltas: List<MarkDelta>, receivedAt: Long): Pair<List<PositionRow>, Boolean> {
    val byMint = deltas.associateBy { it.mint }
    var touched = false
    val merged = rows.map { row ->
        val d = byMint[row.mint] ?: return@map row
        touched = true
        row.copy(
            markPrice = d.markPrice,
            marketValueUsd = d.marketValueUsd.or(row.marketValueUsd),
            pnlUsd = d.pnlUsd.or(row.pnlUsd),
            pnlPct = d.pnlPct.or(row.pnlPct),
            stopPrice = d.stopPrice.or(row.stopPrice),
            peakPrice = d.peakPrice.or(row.peakPrice),
            markAgeMs = d.markAgeMs,
            markLocalAt = receivedAt - d.markAgeMs,
            markFeed = d.markFeed.ifBlank { row.markFeed },
            netPnlUsd = if (d.netKnown) d.netPnlUsd else row.netPnlUsd,
            netPnlPct = if (d.netKnown) d.netPnlPct else row.netPnlPct,
            exitSlippage = if (d.netKnown) d.exitSlippage else row.exitSlippage,
            marks = d.marks ?: row.marks
        )
    }
    return Pair(merged, touched)
}

/** Look-only feeds. Opening one does not send a desk order. v13.2: Birdeye moved to /solana/token/<mint>. */
fun chartLinks(mint: String): List<Pair<String, String>> = listOf(
    Pair("DexScreener", "https://dexscreener.com/solana/$mint"),
    Pair("Birdeye", "https://birdeye.so/solana/token/$mint"),
    Pair("Jupiter", "https://jup.ag/tokens/$mint")
)
