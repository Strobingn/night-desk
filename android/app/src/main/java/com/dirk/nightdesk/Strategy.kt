package com.dirk.nightdesk

import org.json.JSONObject
import java.util.Locale

/** One shadow book's results. Paper only. */
data class VariantScore(
    val variant: String,
    val signal: String,
    val stopPct: Double,
    val trades: Int,
    val wins: Int,
    val winRate: Double,
    val avgWinUsd: Double,
    val avgLossUsd: Double,
    val netUsd: Double,
    val avgNetUsd: Double,
    val maxDrawdownUsd: Double,
    val open: Int,
    val active: Boolean,
    val ready: Boolean
)

/** The desk's trading engine: its switch, sizes, and the scorecard. Null on a desk older than 13.30. */
data class StrategyView(
    val enabled: Boolean,
    val targetNetUsd: Double,
    val tradeUsd: Double,
    val maxOpen: Int,
    val readyTrades: Int,
    val watching: Int,
    val signals: Int,
    val variants: List<VariantScore>,
    val note: String
)

object Strategy {
    fun parse(json: JSONObject?): StrategyView? {
        if (json == null) return null
        val rows = json.optJSONArray("variants")
        val variants = buildList {
            if (rows != null) {
                for (i in 0 until rows.length()) {
                    val row = rows.optJSONObject(i) ?: continue
                    val id = row.optText("variant")
                    if (id.isBlank()) continue
                    add(
                        VariantScore(
                            variant = id,
                            signal = row.optText("signal"),
                            stopPct = row.optFinite("stopPct"),
                            trades = row.optFinite("trades").toInt(),
                            wins = row.optFinite("wins").toInt(),
                            winRate = row.optFinite("winRate"),
                            avgWinUsd = row.optFinite("avgWinUsd"),
                            avgLossUsd = row.optFinite("avgLossUsd"),
                            netUsd = row.optFinite("netUsd"),
                            avgNetUsd = row.optFinite("avgNetUsd"),
                            maxDrawdownUsd = row.optFinite("maxDrawdownUsd"),
                            open = row.optFinite("open").toInt(),
                            active = row.optBoolean("active", false),
                            ready = row.optBoolean("ready", false)
                        )
                    )
                }
            }
        }
        val fired = json.optJSONObject("stats")?.optJSONObject("signals")
        val signals = (fired?.optFinite("launch") ?: 0.0) + (fired?.optFinite("momentum") ?: 0.0)
        return StrategyView(
            enabled = json.optBoolean("enabled", false),
            targetNetUsd = json.optFinite("targetNetUsd"),
            tradeUsd = json.optFinite("tradeUsd"),
            maxOpen = json.optFinite("maxOpen").toInt(),
            readyTrades = json.optFinite("readyTrades", 200.0).toInt(),
            watching = json.optFinite("watching").toInt(),
            signals = signals.toInt(),
            variants = variants,
            note = json.optText("note")
        )
    }

    /** "Launch · 1% stop" */
    fun label(v: VariantScore): String {
        val name = v.signal.replaceFirstChar { it.uppercase() }.ifBlank { v.variant }
        return "$name · ${"%.0f".format(Locale.US, v.stopPct * 100)}% stop"
    }

    /** One line under the switch. */
    fun summary(view: StrategyView): String {
        val size = "$" + "%.0f".format(Locale.US, view.tradeUsd)
        val target = "$" + "%.2f".format(Locale.US, view.targetNetUsd)
        val state = if (view.enabled) "On" else "Off"
        return "$state · paper · $size a trade · ${view.maxOpen} open at most · take-profit $target net · watching ${view.watching} · ${view.signals} signals"
    }

    /** "12 trades · 42% wins · net +$3.10 · avg +$0.26" or "No trades yet". */
    fun stats(v: VariantScore): String {
        if (v.trades <= 0) return if (v.open > 0) "No closed trades yet · ${v.open} open" else "No trades yet"
        val wins = "%.0f".format(Locale.US, v.winRate * 100)
        val open = if (v.open > 0) " · ${v.open} open" else ""
        return "${v.trades} trades · $wins% wins · net ${signedUsd(v.netUsd)} · avg ${signedUsd(v.avgNetUsd)}$open"
    }

    fun signedUsd(n: Double): String {
        val sign = if (n > 0.004) "+" else if (n < -0.004) "−" else ""
        return sign + "$" + "%.2f".format(Locale.US, kotlin.math.abs(n))
    }
}
