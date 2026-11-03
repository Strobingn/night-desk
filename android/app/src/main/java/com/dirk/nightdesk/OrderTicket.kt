package com.dirk.nightdesk

import java.util.Locale

/** v13.11 order ticket rules on the phone (pure; the desk re-checks every order). */
object OrderTicket {
    val SIDE_LABEL = mapOf("limit_buy" to "Limit buy", "take_profit" to "Take profit", "stop_sell" to "Stop")
    val BASIS_LABEL = mapOf("pct_entry" to "% entry", "pct_now" to "% now", "price" to "Price", "mcap" to "MCap")

    /** % from entry only on a held coin. */
    fun basesFor(side: String): List<String> =
        if (side == "limit_buy") listOf("pct_now", "price", "mcap") else listOf("pct_entry", "pct_now", "price", "mcap")

    fun defaultValue(side: String, basis: String): String = when {
        basis == "price" || basis == "mcap" -> ""
        side == "limit_buy" -> "-10"
        side == "take_profit" -> "50"
        else -> "-2"
    }

    fun parse(raw: String): Double? = raw.replace(",", "").replace("$", "").replace("%", "").trim().toDoubleOrNull()?.takeIf { it.isFinite() }

    /** Trigger preview. Null for a market cap (the desk converts it) or anything that is not a real price. */
    fun preview(basis: String, value: Double?, mark: Double?, entry: Double?): Double? {
        if (value == null) return null
        val p = when (basis) {
            "price" -> value
            "pct_now" -> mark?.takeIf { it > 0 }?.let { it * (1 + value / 100) }
            "pct_entry" -> entry?.takeIf { it > 0 }?.let { it * (1 + value / 100) }
            else -> null
        }
        return p?.takeIf { it > 0 && it.isFinite() }
    }

    fun statusText(o: DeskOrder): String = when (o.status) {
        "open" -> o.waiting ?: o.note?.takeIf { it.startsWith("Refused") }
            ?: o.distancePct?.let { (if (it > 0) "+" else "") + "%.1f".format(Locale.US, it * 100) + "% away" } ?: "watching"
        "working" -> "firing…"
        else -> o.note ?: o.status
    }

    fun amountText(o: DeskOrder): String =
        if (o.side == "limit_buy") o.sizeUsd?.let { " · " + formatUsd(it) } ?: "" else " · ${Math.round((o.fraction ?: 1.0) * 100)}%"
}
