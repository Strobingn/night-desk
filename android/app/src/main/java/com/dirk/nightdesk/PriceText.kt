package com.dirk.nightdesk

import java.util.Locale
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * v13.8 prices for coin cards. ≥ 1: 4 decimals; ≥ 0.01: 6 decimals; below that 4 significant
 * digits, with 4+ leading zeros folded into a subscript count: 0.00000000004143 → "0.0₁₀4143".
 * Same rule as the web (web/src/format.ts tinyPx) and the desk's log lines.
 */
object PriceText {
    private const val SUB = "₀₁₂₃₄₅₆₇₈₉"

    fun px(n: Double): String = when {
        !n.isFinite() || n < 0 -> "—"
        n == 0.0 -> "0"
        n >= 1 -> "%.4f".format(Locale.US, n)
        n >= 0.01 -> "%.6f".format(Locale.US, n)
        else -> tiny(n)
    }

    fun tiny(n: Double): String {
        if (!(n > 0) || !n.isFinite()) return "—"
        var exp = floor(log10(n)).toInt()
        var digits = (n / 10.0.pow(exp - 3)).roundToLong()
        if (digits >= 10_000) {
            digits = (digits / 10.0).roundToLong()
            exp += 1
        }
        val zeros = -exp - 1
        if (zeros < 0) return "%.4g".format(Locale.US, n)
        if (zeros < 4) return "%.${zeros + 4}f".format(Locale.US, n)
        val sub = zeros.toString().map { SUB[it - '0'] }.joinToString("")
        return "0.0$sub" + (digits.toString().trimEnd('0').ifEmpty { "0" })
    }
}
