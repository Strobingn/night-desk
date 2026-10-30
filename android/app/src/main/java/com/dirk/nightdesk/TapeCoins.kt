package com.dirk.nightdesk

/** v13 Tape coin cards — the same fold as web/src/coins.ts. */
enum class Verdict(val label: String, val rank: Int) {
    SEEN("Scouted", 0), KILLED("Killed", 1), NEAR("Near miss", 2), TRADE("Passed", 3), BOUGHT("Bought", 4), OPEN("Open", 5)
}

data class CoinCard(
    val mint: String,
    val symbol: String,
    val lastTs: Long,
    val source: String?,
    val mark: Double?,
    val vol1h: Double?,
    val score: Double?,
    val verdict: Verdict,
    val reason: String?,
    val codes: List<String>,
    /** Latest event for this mint, so the existing Buy dialog can use it. */
    val event: TapeEvent
)

private val SCOUT_RE = Regex("""Mark ([0-9.eE-]+), 1h volume \$([0-9,.]+)""")

fun coinCards(events: List<TapeEvent>, openMints: Set<String>, limit: Int = 60): List<CoinCard> {
    class Acc(var symbol: String, val first: TapeEvent) {
        var lastTs = 0L
        var source: String? = null
        var mark: Double? = null
        var vol: Double? = null
        var score: Double? = null
        var verdict = Verdict.SEEN
        var reason: String? = null
        var codes: List<String> = emptyList()
        var event: TapeEvent = first
    }
    val map = LinkedHashMap<String, Acc>()
    for (e in events) {
        val mint = e.mint ?: continue
        val acc = map.getOrPut(mint) { Acc(e.symbol ?: mint.take(4), e) }
        if (!e.symbol.isNullOrBlank()) acc.symbol = e.symbol
        if (e.stage != "risk" && e.stage != "system") {
            if (e.ts >= acc.lastTs) acc.event = e
            acc.lastTs = maxOf(acc.lastTs, e.ts)
        }
        fun bump(v: Verdict) {
            if (v.rank >= acc.verdict.rank || acc.verdict == Verdict.KILLED) acc.verdict = v
        }
        when {
            e.stage == "scout" -> {
                SCOUT_RE.find(e.message)?.let { m ->
                    acc.mark = m.groupValues[1].toDoubleOrNull()?.takeIf { it > 0 }
                    acc.vol = m.groupValues[2].replace(",", "").trimEnd('.').toDoubleOrNull()
                }
                if (!e.detail.isNullOrBlank()) acc.source = e.detail
            }
            e.stage == "filter" && e.kind == "reject" -> {
                if (acc.verdict != Verdict.OPEN && acc.verdict != Verdict.BOUGHT) acc.verdict = Verdict.KILLED
                acc.codes = (e.detail ?: e.code ?: "").split(Regex(""",\s*""")).filter { it.isNotBlank() }
                acc.reason = e.message.replace(Regex("""^Filter killed [^.]*\.\s*"""), "")
            }
            e.stage == "analyst" -> {
                e.detail?.toDoubleOrNull()?.let { acc.score = it }
                if (e.kind == "pass") bump(Verdict.TRADE) else {
                    bump(Verdict.NEAR)
                    acc.reason = e.message.replace(Regex("""^Analyst scored [^.]*\.[0-9]+\.\s*"""), "")
                }
            }
            e.stage == "executor" && e.kind == "fill" -> bump(Verdict.BOUGHT)
        }
    }
    return map.entries
        .map { (mint, a) ->
            CoinCard(mint, a.symbol, a.lastTs, a.source, a.mark, a.vol, a.score, if (mint in openMints) Verdict.OPEN else a.verdict, a.reason, a.codes, a.event)
        }
        .filter { it.lastTs > 0 || it.verdict == Verdict.OPEN }
        .sortedByDescending { it.lastTs }
        .take(limit)
}

/** Equity at the start of today (local), from the series; falls back to the book start. */
fun dayBase(points: List<EquityPoint>, fallback: Double, midnightMs: Long): Double {
    var before: Double? = null
    for (p in points) {
        if (p.t < midnightMs) before = p.equity else return before ?: p.equity
    }
    return before ?: fallback
}
