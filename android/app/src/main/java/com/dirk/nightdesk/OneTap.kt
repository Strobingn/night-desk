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

    /**
     * v13.6 the one-tap hint names the limit behind the cap (per-position %, cash, or the
     * max-exposure room) and only says "cut" when the size is actually cut. Same text as the web.
     */
    fun capHint(capLine: String?, capUsd: Double, tapUsd: Double): String {
        val cap = "$" + "%.2f".format(java.util.Locale.US, capUsd)
        val cut = tapUsd > capUsd + 0.005
        if (capLine.isNullOrBlank()) return if (cut) "cut to the $cap cap and cash" else "within the $cap cap"
        return if (cut) "cut to $cap by the $capLine" else "within the $cap cap, set by the $capLine"
    }

    /** v13.5: a LIVE desk always taps the live per-trade size ($5 default), never this phone's paper amount. */
    fun effectiveTapUsd(mode: String?, tapUsd: Double, liveTradeUsd: Double?): Double =
        if (mode == "live") (liveTradeUsd?.takeIf { it > 0 && it.isFinite() } ?: 5.0) else tapUsd

    /**
     * Armed desk: the lightning button is still the phone's paper size. Live buys use liveTradeUsd.
     * The $100 figure on Search was this paper size, mislabeled as live. Server live size stays $5 unless saved otherwise.
     */
    fun splitSizeLine(paperUsd: Double, liveUsd: Double, trailPct: Double, stopPct: Double, aiLive: Boolean): String {
        val ai = if (aiLive) "" else " AI: paper."
        return "Paper one tap ${usd(paperUsd)} (this phone). Live buys ${usd(liveUsd)} each · trail ${"%.1f".format(java.util.Locale.US, trailPct * 100)}% · stop −${"%.0f".format(java.util.Locale.US, stopPct * 100)}%.$ai Live size is Settings → Live wallet."
    }

    fun splitBuyLine(paperUsd: Double, liveUsd: Double, capHint: String): String =
        "Paper one tap buys ${usd(paperUsd)} now ($capHint). Live buttons buy ${usd(liveUsd)}."

    /** Home checklist chip. Full readiness lines stay collapsed in Settings. */
    fun liveStatusChip(mode: String?, operatorReady: Boolean, tradeUsd: Double, dailyCapUsd: Double?, sol: Double?): String {
        val head = when {
            mode == "live" && operatorReady -> "LIVE ready"
            mode == "live" -> "LIVE · checklist off"
            operatorReady -> "STILL PAPER · checklist marked"
            else -> "STILL PAPER"
        }
        val trade = usd(tradeUsd) + "/trade"
        val day = if (dailyCapUsd != null && dailyCapUsd.isFinite() && dailyCapUsd > 0) usd(dailyCapUsd) + "/day" else "no day cap"
        val solBit = if (sol != null && sol.isFinite()) " · wallet ${"%.4f".format(java.util.Locale.US, sol)} SOL" else ""
        return "$head · $trade · $day$solBit"
    }

    private fun usd(n: Double): String {
        val v = if (n.isFinite() && n > 0) n else 0.0
        val whole = kotlin.math.abs(v - kotlin.math.round(v)) < 1e-9
        return "$" + if (whole) "%.0f".format(java.util.Locale.US, v) else "%.2f".format(java.util.Locale.US, v)
    }

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
            else -> "Key loaded: no. Set WALLET_PRIVATE_KEY on the desk host."
        }
        if (w.balanceError != null) lines += "Balance: unavailable (${w.balanceError})."
        lines += if (w.live) "LIVE is ON. " + (w.liveScopeLine ?: "One-tap and auto-buys send real swaps.") else
            "LIVE is OFF. " + (if (w.liveRequested) "LIVE_TRADING=true but the desk could not arm." else "LIVE_TRADING is not true.")
        if (w.rpcPublic) lines += "RPC: free public Solana RPC (rate limited)."
        return lines
    }

    /** v13.25 hard-kill refusals keep the desk reason and open Buy anyway. Null when this is not a hard kill. */
    fun hardKillReason(code: String?, error: String?): String? {
        if (code != "HARD_KILL") return null
        val reason = error?.trim().orEmpty()
        return if (reason.isEmpty()) "Hard kill." else reason
    }

    /** Wallet USDC. Dust under one cent is not forced to $0.00. */
    fun formatBalanceUsd(n: Double): String {
        if (!n.isFinite()) return "—"
        val sign = if (n < 0) "−" else ""
        val abs = kotlin.math.abs(n)
        return when {
            abs > 0 && abs < 0.0001 -> sign + "<$0.0001"
            abs < 0.01 -> sign + "$" + "%.4f".format(java.util.Locale.US, abs)
            else -> sign + formatUsd(abs)
        }
    }

    /** `0.2951 SOL · ~$25.45` when the desk already has a SOL/USD mark. */
    fun formatSolHolding(sol: Double?, solUsd: Double?): String {
        if (sol == null || !sol.isFinite()) return "—"
        val qty = "%.4f".format(java.util.Locale.US, sol) + " SOL"
        if (sol > 0 && solUsd != null && solUsd.isFinite() && solUsd > 0) return "$qty · ~${formatBalanceUsd(sol * solUsd)}"
        return qty
    }

    /**
     * Home LIVE strip. SOL plus an approximate dollar value, and USDC with sub-cent precision.
     * Rounded book cash is only a fallback when the raw balance is missing.
     */
    fun liveCashLabel(sol: Double?, solUsd: Double?, usdc: Double?, cashUsd: Double, cashKnown: Boolean, balanceError: String?): String {
        val known = cashKnown && balanceError.isNullOrBlank()
        val usdcText = when {
            usdc != null && usdc.isFinite() && (known || usdc > 0) -> "USDC ${formatBalanceUsd(usdc)}" + if (balanceError.isNullOrBlank()) "" else " stale"
            !balanceError.isNullOrBlank() && cashUsd > 0 -> "USDC ${formatBalanceUsd(cashUsd)} stale"
            !known -> "USDC unknown"
            else -> "USDC ${formatBalanceUsd(usdc ?: cashUsd)}"
        }
        return if (sol != null && sol.isFinite()) formatSolHolding(sol, solUsd) + " · " + usdcText else usdcText
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
        if (!ok) {
            val code = json.optText("code").ifBlank { null }
            return "$symbol: ${json.optText("error", "sell failed")}" + (if (code != null) " ($code)" else "")
        }
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
        "TAKE_PROFIT" -> "take-profit"
        "STRATEGY_STOP" -> "engine stop"
        "BREAKEVEN_STOP" -> "breakeven"
        "TIME_LIMIT" -> "time limit"
        else -> code.lowercase().replace('_', ' ')
    }

    /** Stop-type exits that should ping when Stops alerts are on. */
    fun isStopExit(code: String?): Boolean = code == "STOP_LOSS" || code == "TRAIL_STOP" || code == "GAP_RUG" || code == "STRATEGY_STOP" || code == "BREAKEVEN_STOP"

    private fun signed(n: Double): String = (if (n > 0) "+" else if (n < 0) "−" else "") + formatUsd(kotlin.math.abs(n))
    private fun pct(f: Double): String = (if (f > 0) "+" else if (f < 0) "−" else "") + "%.2f".format(java.util.Locale.US, kotlin.math.abs(f * 100)) + "%"
    private fun priceText(p: Double): String = when {
        p >= 1 -> "$" + "%.4f".format(java.util.Locale.US, p)
        else -> "$" + PriceText.px(p)
    }
}

/**
 * v13.9 LIVE BUY / LIVE SELL beside a paper position. Pure helpers (unit-tested).
 * A LIVE tap never falls back to a paper trade.
 */
object LiveTap {
    /** "LIVE BUY $5" (whole dollars without cents). */
    fun buyLabel(usd: Double): String {
        val n = if (usd.isFinite() && usd > 0) usd else 5.0
        val whole = kotlin.math.abs(n - kotlin.math.round(n)) < 1e-9
        return "LIVE BUY $" + if (whole) "%.0f".format(java.util.Locale.US, n) else "%.2f".format(java.util.Locale.US, n)
    }

    /** The live size: the live book's trade size, else the saved liveTradeUsd, else $5. */
    fun size(snap: DeskSnapshot?): Double =
        snap?.liveBook?.tradeUsd?.takeIf { it.isFinite() && it > 0 } ?: snap?.liveTradeUsd?.takeIf { it.isFinite() && it > 0 } ?: 5.0

    /** Null = armed, send it. Otherwise the plain message shown instead of doing anything. */
    fun block(snap: DeskSnapshot?): String? {
        if (snap == null) return "Desk not loaded yet. Nothing was sent."
        if (snap.liveBook != null) return null
        val why = snap.liveNotArmed ?: if (snap.wallet?.keyLoaded == false) "Live not armed: wallet key missing." else "Live not armed."
        return "$why Nothing was sent."
    }

    /** Live positions by mint (live book only). */
    fun held(snap: DeskSnapshot?): Map<String, PositionRow> = snap?.liveBook?.positions?.associateBy { it.mint } ?: emptyMap()
}

