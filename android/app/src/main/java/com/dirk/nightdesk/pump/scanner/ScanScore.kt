package com.dirk.nightdesk.pump.scanner

/**
 * Same rug rule as the server scorer: any flag forces score 0.
 * The server remains the ranking source of truth for the live board.
 */
data class ScanRow(
    val mint: String,
    val volume: Double,
    val progressPct: Double,
    val buy: Double,
    val sell: Double,
    val uniqueBuyers: Double,
    val holderGrowth: Double,
    val ageMs: Double,
    val devHoldingPct: Double? = null,
    val top10HoldingPct: Double? = null,
    val mintAuthority: String? = null,
    val freezeAuthority: String? = null,
    val creatorDumping: Boolean = false
)

private const val SYSTEM = "11111111111111111111111111111111"

fun rugReasons(row: ScanRow): List<String> {
    val reasons = ArrayList<String>()
    if (row.devHoldingPct != null && row.devHoldingPct > 0.1) reasons.add("dev holding")
    if (row.top10HoldingPct != null && row.top10HoldingPct > 0.3) reasons.add("top 10 holding")
    if (authorityLive(row.mintAuthority)) reasons.add("mint authority")
    if (authorityLive(row.freezeAuthority)) reasons.add("freeze authority")
    if (row.creatorDumping) reasons.add("creator dumping")
    return reasons
}

fun scoreRow(row: ScanRow): Double {
    if (rugReasons(row).isNotEmpty()) return 0.0
    val volume = unit(row.volume / 10_000_000_000.0)
    val progress = unit(row.progressPct / 100.0)
    val flow = row.buy + row.sell
    val buySell = if (flow <= 0) 0.0 else unit(row.buy / flow)
    val buyers = unit(row.uniqueBuyers / 40.0)
    val holders = unit(row.holderGrowth / 25.0)
    val age = 1.0 - unit(row.ageMs / (30.0 * 60.0 * 1000.0))
    return volume * 0.25 + progress * 0.15 + buySell * 0.2 + buyers * 0.15 + holders * 0.15 + age * 0.1
}

private fun authorityLive(value: String?): Boolean {
    val trimmed = value?.trim().orEmpty()
    return trimmed.isNotEmpty() && trimmed != SYSTEM
}

private fun unit(value: Double): Double {
    if (!value.isFinite() || value <= 0) return 0.0
    return if (value >= 1) 1.0 else value
}
