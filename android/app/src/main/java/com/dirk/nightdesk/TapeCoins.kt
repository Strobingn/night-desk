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
    val event: TapeEvent,
    /** v13.1: 5m volume, 1h price change in percent, and 1-based rank by 1h volume. */
    val vol5m: Double? = null,
    val change1h: Double? = null,
    val volRank: Int? = null,
    /** v13.10 short reason a live value is missing ("no pool yet"); where the live price came from. */
    val why: String? = null,
    val quoteSource: String? = null
)

/** v13.10 the desk's live Tape quote (snapshot `tapeQuotes`). Unknown values are null, never 0 for price. */
data class TapeQuote(
    val priceUsd: Double?,
    val vol1hUsd: Double?,
    val vol5mUsd: Double?,
    val change1hPct: Double?,
    val source: String?,
    val at: Long,
    val why: String?
)

private const val SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉"
private val TINY_RE = Regex("""^0\.0([₀-₉]+)(\d+)$""")

/** v13.10 a desk price string, plain or v13.8 subscript-zero ("0.0₅207" = 0.00000207). Null for 0 / junk. */
fun parsePxText(raw: String?): Double? {
    val t = raw?.trim().orEmpty()
    if (t.isEmpty()) return null
    val m = TINY_RE.find(t)
    val plain = if (m != null) {
        val zeros = m.groupValues[1].map { SUB_DIGITS.indexOf(it) }.joinToString("").toIntOrNull() ?: return null
        "0." + "0".repeat(zeros) + m.groupValues[2]
    } else t.replace(",", "")
    return plain.toDoubleOrNull()?.takeIf { it > 0 && it.isFinite() }
}

/** v13.10 short text in place of a bare dash on a Tape card. */
fun tapeMissing(coin: CoinCard, field: String): String = when {
    field == "price" -> coin.why ?: "checking…"
    coin.why == "no trades yet" -> "no trades"
    coin.quoteSource == "pump.fun curve" -> "curve only"
    // Quoted, but DexScreener has no pair with this number (priced by Jupiter / the sighting only).
    coin.quoteSource != null || coin.why != null -> "no DEX data"
    else -> "checking…"
}

/** v13.1 per-device Tape sort. Volume is the default. */
enum class TapeSort(val label: String) { VOLUME("Volume"), NEWEST("Newest"), SCORE("Score");
    companion object {
        fun parse(raw: String?): TapeSort = entries.firstOrNull { it.name == raw } ?: VOLUME
    }
}

const val TOP_VOLUME = 10
const val HOT_RANK = 3

private val V5_RE = Regex("""5m volume \$([0-9,.]+)""")
private val CHANGE_RE = Regex("""1h change ([+-]?)([0-9.]+)%""")

private fun money(raw: String): Double? = raw.replace(",", "").trimEnd('.').toDoubleOrNull()?.takeIf { it.isFinite() }

fun sortCoins(rows: List<CoinCard>, mode: TapeSort): List<CoinCard> {
    fun vol(c: CoinCard) = c.vol1h?.takeIf { it.isFinite() } ?: -1.0
    fun sc(c: CoinCard) = c.score?.takeIf { it.isFinite() } ?: -1.0
    return when (mode) {
        TapeSort.NEWEST -> rows.sortedByDescending { it.lastTs }
        TapeSort.SCORE -> rows.sortedWith(compareByDescending<CoinCard> { sc(it) }.thenByDescending { vol(it) }.thenByDescending { it.lastTs })
        TapeSort.VOLUME -> rows.sortedWith(compareByDescending<CoinCard> { vol(it) }.thenByDescending { it.vol5m ?: 0.0 }.thenByDescending { it.lastTs })
    }
}

private val SCOUT_RE = Regex("""Mark ([0-9.eE₀-₉+-]+), 1h volume \$([0-9,.]+)""")

fun coinCards(events: List<TapeEvent>, openMints: Set<String>, limit: Int = 60, quotes: Map<String, TapeQuote> = emptyMap()): List<CoinCard> {
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
        var vol5m: Double? = null
        var change: Double? = null
        var firstMark: Double? = null
        var changeSeen: Double? = null
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
                    val mark = parsePxText(m.groupValues[1])
                    if (mark != null) {
                        val first = acc.firstMark
                        if (first == null) acc.firstMark = mark else acc.changeSeen = (mark / first - 1) * 100
                        acc.mark = mark
                    }
                    acc.vol = money(m.groupValues[2])
                }
                V5_RE.find(e.message)?.let { m -> money(m.groupValues[1])?.let { acc.vol5m = it } }
                CHANGE_RE.find(e.message)?.let { m ->
                    m.groupValues[2].toDoubleOrNull()?.takeIf { it.isFinite() }?.let { acc.change = if (m.groupValues[1] == "-") -it else it }
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
    val rows = map.entries
        .map { (mint, a) ->
            CoinCard(
                mint, a.symbol, a.lastTs, a.source, a.mark, a.vol, a.score, if (mint in openMints) Verdict.OPEN else a.verdict, a.reason, a.codes, a.event,
                vol5m = a.vol5m,
                change1h = a.change ?: a.changeSeen?.takeIf { it.isFinite() }
            ).let { withQuote(it, quotes[mint]) }
        }
        .filter { it.lastTs > 0 || it.verdict == Verdict.OPEN }
        .sortedByDescending { it.lastTs }
        .take(limit)
    val ranks = rows
        .filter { (it.vol1h ?: 0.0) > 0 && it.vol1h!!.isFinite() }
        .sortedWith(compareByDescending<CoinCard> { it.vol1h ?: 0.0 }.thenByDescending { it.vol5m ?: 0.0 })
        .mapIndexed { i, c -> c.mint to (i + 1) }
        .toMap()
    return rows.map { it.copy(volRank = ranks[it.mint]) }
}

/** v13.10: the desk's live Tape quote wins over the first-sighting line (which is frozen at that moment). */
private fun withQuote(c: CoinCard, q: TapeQuote?): CoinCard {
    if (q == null) return c
    return c.copy(
        mark = q.priceUsd?.takeIf { it > 0 && it.isFinite() } ?: c.mark,
        // A live 0 never hides real volume the sighting saw (fresh pump.fun pairs read 0 on DexScreener).
        vol1h = q.vol1hUsd?.takeIf { it.isFinite() && (it > 0 || c.vol1h == null) } ?: c.vol1h,
        vol5m = q.vol5mUsd?.takeIf { it.isFinite() && (it > 0 || c.vol5m == null) } ?: c.vol5m,
        change1h = q.change1hPct?.takeIf { it.isFinite() } ?: c.change1h,
        why = q.why,
        quoteSource = q.source
    )
}

/** Equity at the start of today (local), from the series; falls back to the book start. */
fun dayBase(points: List<EquityPoint>, fallback: Double, midnightMs: Long): Double {
    var before: Double? = null
    for (p in points) {
        if (p.t < midnightMs) before = p.equity else return before ?: p.equity
    }
    return before ?: fallback
}

/** v13.4 Tape toolbar text (pure, unit-tested). */
object TapeToolbar {
    const val PREF_SCOUT_OPEN = "tape_scout_open"

    data class ScoutSummary(val live: Int, val total: Int, val perMin: Int, val down: Int, val slow: Int) {
        val text: String get() = "$live/$total live · $perMin/min"
        val badge: String? get() = when {
            down > 0 -> "$down down"
            slow > 0 -> "$slow slow"
            else -> null
        }
    }

    fun scout(sources: List<FeedSource>): ScoutSummary = ScoutSummary(
        live = sources.count { it.state == "live" },
        total = sources.size,
        perMin = sources.sumOf { it.sightingsPerMin },
        down = sources.count { it.state == "down" },
        slow = sources.count { it.state == "backoff" || it.state == "stale" }
    )

    fun oneTapChip(tapUsd: Double, slipPct: Double): String {
        val size = if (tapUsd >= 100) "%.0f".format(java.util.Locale.US, tapUsd) else "%.2f".format(java.util.Locale.US, tapUsd)
        val slip = if (slipPct == kotlin.math.floor(slipPct)) "%.0f".format(java.util.Locale.US, slipPct) else "%.1f".format(java.util.Locale.US, slipPct)
        return "⚡ $$size · slip $slip%"
    }

    fun sortChip(sort: TapeSort): String = "↕ " + when (sort) {
        TapeSort.VOLUME -> "Vol"
        TapeSort.NEWEST -> "New"
        TapeSort.SCORE -> "Score"
    }

    /** Compact card price: 4 significant digits. */
    fun shortPrice(n: Double): String {
        // v13.10: never a 0 price.
        if (!n.isFinite() || n <= 0) return "—"
        if (n >= 1000) return "%.0f".format(java.util.Locale.US, n)
        if (n >= 1) return "%.3f".format(java.util.Locale.US, n)
        if (n >= 0.0001) return java.math.BigDecimal(n).round(java.math.MathContext(4)).stripTrailingZeros().toPlainString()
        return PriceText.tiny(n)
    }
}
