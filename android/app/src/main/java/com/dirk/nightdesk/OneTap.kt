package com.dirk.nightdesk

import org.json.JSONObject

/** v13.3 one-tap trading helpers (pure, unit-tested). Same wording as web/src/onetap.ts. */
object OneTap {
    const val PREF_TAP_USD = "one_tap_usd"

    fun newIdemKey(): String = java.util.UUID.randomUUID().toString()

    /** The one-tap size: this phone's choice, else the desk's manual default, else the cap. */
    fun defaultTapUsd(saved: Double?, defaultBuyUsd: Double?, capUsd: Double): Double = when {
        saved != null && saved.isFinite() && saved > 0 -> saved
        defaultBuyUsd != null && defaultBuyUsd > 0 -> defaultBuyUsd
        else -> kotlin.math.max(1.0, kotlin.math.floor(capUsd * 100.0) / 100.0)
    }

    /** v13.5: a LIVE desk always taps the live per-trade size ($5 default), never this phone's paper amount. */
    fun effectiveTapUsd(mode: String?, tapUsd: Double, liveTradeUsd: Double?): Double =
        if (mode == "live") (liveTradeUsd?.takeIf { it > 0 && it.isFinite() } ?: 5.0) else tapUsd

    /** v13.5 wallet card: first 4 … last 4 of the public address. */
    fun shortAddress(address: String?): String = when {
        address.isNullOrBlank() -> "—"
        address.length > 12 -> address.take(4) + "…" + address.takeLast(4)
        else -> address
    }

    /** v13.5 wallet card lines. Same wording as web/src/screens/Wallet.tsx. Never a secret. */
    fun walletLines(w: WalletInfo?, mode: String): List<String> {
        if (w == null) return listOf("Wallet status not reported by this desk build.")
        val lines = mutableListOf<String>()
        lines += when {
            w.keyLoaded -> "Key loaded: yes (" + (if (w.keySource == "env") "WALLET_PRIVATE_KEY" else "keypair file") + ")."
            w.keyInvalid -> "Key loaded: no. WALLET_PRIVATE_KEY is set but is not a Solana private key."
            else -> "Key loaded: no. Fill WALLET_PRIVATE_KEY= in Austin's .env."
        }
        if (w.balanceError != null) lines += "Balance: unavailable (${w.balanceError})."
        lines += if (w.live) "LIVE is ON. One-tap and auto-buys send real swaps." else
            "LIVE is OFF. " + (if (w.liveRequested) "LIVE_TRADING=true but the desk could not arm." else "LIVE_TRADING is not true.")
        if (w.rpcPublic) lines += "RPC: free public Solana RPC (rate limited)."
        return lines
    }

    fun buyText(symbol: String, json: JSONObject?, ok: Boolean, ms: Long): String {
        if (json == null) return "$symbol: buy refused"
        if (!ok) {
            val code = json.optText("code").ifBlank { null }
            val hint = if (code == "HARD_KILL" || code == "REVENGE_COOLDOWN") " Use Buy… to override." else ""
            return "$symbol: ${json.optText("error", "buy refused")}" + (if (code != null) " ($code)" else "") + hint
        }
        val sym = json.optText("symbol").ifBlank { symbol }
        val size = json.optFinite("sizeUsd", 0.0)
        val fill = json.optFinite("fillPriceUsd", Double.NaN).takeIf { it.isFinite() && it > 0 }
        val clamped = json.optFinite("clampedFrom", Double.NaN).takeIf { it.isFinite() }
        val mode = json.optText("mode").ifBlank { "paper" }.let { if (it == "live") "LIVE" else it }
        return "Bought $sym ${formatUsd(size)}" + (if (fill != null) " @ ${priceText(fill)}" else "") +
            (if (clamped != null) " (cut from ${formatUsd(clamped)} to the cap)" else "") + " · $mode · $ms ms"
    }

    fun sellText(symbol: String, json: JSONObject?, ok: Boolean, ms: Long): String {
        if (json == null) return "$symbol: sell failed"
        if (!ok) return "$symbol: ${json.optText("error", "sell failed")}"
        val sym = json.optText("symbol").ifBlank { symbol }
        val proceeds = json.optFinite("proceedsUsd", Double.NaN).takeIf { it.isFinite() }
        val pnl = json.optFinite("pnlUsd", Double.NaN).takeIf { it.isFinite() }
        val pnlPct = json.optFinite("pnlPct", Double.NaN).takeIf { it.isFinite() }
        val exit = json.optFinite("exitPrice", Double.NaN).takeIf { it.isFinite() && it > 0 }
        val gap = if (json.optText("exitCode") == "GAP_RUG") " · gap/rug" else ""
        val pnlText = if (pnl != null) " " + signed(pnl) + (if (pnlPct != null) " (" + pct(pnlPct) + ")" else "") else ""
        return "Sold $sym" + (if (proceeds != null) " for ${formatUsd(proceeds)}" else "") +
            (if (exit != null) " @ ${priceText(exit)}" else "") + pnlText + gap + " · $ms ms"
    }

    /** Honest exit label for trades and recap rows. */
    fun exitLabel(code: String): String = when (code) {
        "GAP_RUG" -> "gap/rug"
        "STOP_LOSS" -> "stop-loss"
        "TRAIL_STOP" -> "trailing stop"
        "MANUAL_CLOSE" -> "manual sell"
        "PARTIAL_SELL" -> "partial sell"
        else -> code.lowercase().replace('_', ' ')
    }

    /** Stop-type exits that should ping when Stops alerts are on. */
    fun isStopExit(code: String?): Boolean = code == "STOP_LOSS" || code == "TRAIL_STOP" || code == "GAP_RUG"

    private fun signed(n: Double): String = (if (n > 0) "+" else if (n < 0) "−" else "") + formatUsd(kotlin.math.abs(n))
    private fun pct(f: Double): String = (if (f > 0) "+" else if (f < 0) "−" else "") + "%.2f".format(java.util.Locale.US, kotlin.math.abs(f * 100)) + "%"
    private fun priceText(p: Double): String = when {
        p >= 1 -> "$" + "%.4f".format(java.util.Locale.US, p)
        else -> "$" + java.math.BigDecimal(p).round(java.math.MathContext(4)).stripTrailingZeros().toPlainString()
    }
}
