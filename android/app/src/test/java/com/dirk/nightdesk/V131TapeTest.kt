package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class V131TapeTest {
    private var n = 0
    private fun scout(ts: Long, mint: String, vol: String, extra: String = "", mark: String = "0.001") =
        TapeEvent("e${n++}", ts, "scout", "info", "Scout found $mint on pumpfun. Mark $mark, 1h volume \$$vol$extra.", null, mint, mint, "pumpfun")

    private val events = listOf(
        scout(1, "A", "5,000.00"),
        scout(2, "B", "250,000.00", ", 5m volume \$12,000.00, 1h change +18.4%"),
        scout(3, "C", "40,000.00", ", 1h change -6.0%"),
        TapeEvent("x", 4, "analyst", "pass", "Analyst scored A 0.71.", null, "A", "A", "0.71"),
        scout(5, "D", "0.00")
    )

    @Test fun parsesVolumeChangeAndRank() {
        val by = coinCards(events, emptySet()).associateBy { it.mint }
        assertEquals(250_000.0, by["B"]!!.vol1h!!, 1e-6)
        assertEquals(12_000.0, by["B"]!!.vol5m!!, 1e-6)
        assertEquals(18.4, by["B"]!!.change1h!!, 1e-9)
        assertEquals(-6.0, by["C"]!!.change1h!!, 1e-9)
        assertEquals(1, by["B"]!!.volRank)
        assertEquals(2, by["C"]!!.volRank)
        assertEquals(3, by["A"]!!.volRank)
        assertNull(by["D"]!!.volRank)
    }

    @Test fun sortsVolumeFirstByDefault() {
        val rows = coinCards(events, emptySet())
        assertEquals(TapeSort.VOLUME, TapeSort.parse(null))
        assertEquals(TapeSort.VOLUME, TapeSort.parse("junk"))
        assertEquals(listOf("B", "C", "A", "D"), sortCoins(rows, TapeSort.VOLUME).map { it.mint })
        assertEquals(listOf("D", "A", "C", "B"), sortCoins(rows, TapeSort.NEWEST).map { it.mint })
        assertEquals("A", sortCoins(rows, TapeSort.SCORE).first().mint)
    }

    @Test fun changeFallsBackToMoveSinceFirstSighting() {
        val rows = coinCards(listOf(scout(1, "Z", "1,000.00"), scout(2, "Z", "1,500.00", mark = "0.0015")), emptySet())
        assertEquals(50.0, rows.first().change1h!!, 1e-6)
    }
}
