package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class V132MarksTest {
    private val mint = "9dGdEhbke3J8kBNfb3TUmm2qqfVfLZHS7scxxpCNpump"

    private fun snap(): DeskSnapshot {
        val raw = """{"type":"snapshot","data":{"mode":"paper","cashUsd":90,"equityUsd":100,"sessionPnlUsd":0,
            "rules":{"minVolume1hUsd":10000,"analystMinScore":0.5,"maxTop10Pct":0.35,"maxPositionPct":0.08,"stopLossPct":0.06,"maxEntrySlippage":0.03},
            "prefs":{"maxOpenPositions":12,"positionRefreshMs":2500},
            "positions":[{"mint":"$mint","symbol":"HALVE","pnlUsd":0,"pnlPct":0,"markPrice":1,"stopPrice":0.94,"entryPrice":1,"score":0.6,
              "source":"pumpfun","entry":"analyst","markAgeMs":800,"markFeed":"dexscreener","costUsd":10,"marketValueUsd":10,"openedAt":1}]}}"""
        return parseDeskPayload(raw) ?: error("fixture did not parse")
    }

    @Test fun parsesMarkFeedRefreshAndLocalMarkTime() {
        val before = System.currentTimeMillis()
        val s = snap()
        val row = s.positions.single()
        assertEquals("dexscreener", row.markFeed)
        assertEquals(2_500L, s.positionRefreshMs)
        assertTrue(row.markLocalAt in (before - 800 - 50)..(System.currentTimeMillis() - 800 + 50))
    }

    @Test fun mergesAMarksDeltaAndIgnoresBadOrUnknownRows() {
        val s = snap()
        val msg = parseMarksMessage(
            """{"type":"marks","data":{"now":1,"cashUsd":90,"equityUsd":101,"positions":[
              {"mint":"$mint","markPrice":1.1,"marketValueUsd":11,"pnlUsd":1,"pnlPct":0.1,"stopPrice":0.94,"peakPrice":1.1,"markAgeMs":200,"markAt":5,"markFeed":"chain"},
              {"mint":"Other","markPrice":3,"marketValueUsd":0,"pnlUsd":0,"pnlPct":0,"stopPrice":0,"peakPrice":0,"markAgeMs":0,"markAt":5,"markFeed":"chain"}]}}"""
        )
        assertNotNull(msg)
        val next = s.withMarks(msg!!, receivedAt = 50_000L)
        val row = next.positions.single()
        assertEquals(1.1, row.markPrice, 1e-12)
        assertEquals("chain", row.markFeed)
        assertEquals(49_800L, row.markLocalAt)
        assertEquals(101.0, next.equityUsd, 1e-9)
        assertEquals(3_200L, liveAgeMs(row, 53_000L))
        // A 0 or NaN mark never replaces the last good one.
        val zero = parseMarksMessage("""{"type":"marks","data":{"positions":[{"mint":"$mint","markPrice":0}]}}""")!!
        assertTrue(zero.positions.isEmpty())
        assertSame(next, next.withMarks(zero))
        assertNull(parseMarksMessage("""{"type":"snapshot","data":{}}"""))
    }

    @Test fun freshnessAndLabels() {
        assertEquals(MarkFreshness.FRESH, markFreshness(2_000))
        assertEquals(MarkFreshness.AMBER, markFreshness(10_001))
        assertEquals(MarkFreshness.RED, markFreshness(30_001))
        assertEquals("updated just now", updatedLabel(400))
        assertEquals("updated 3s ago", updatedLabel(3_400))
        assertEquals("updated 2m ago", updatedLabel(125_000))
        assertEquals("pool", feedLabel("chain"))
    }

    @Test fun birdeyeUsesTheWorkingSolanaTokenPath() {
        val bird = chartLinks(mint).first { it.first == "Birdeye" }.second
        assertEquals("https://birdeye.so/solana/token/$mint", bird)
        assertFalse(bird.contains("?chain="))
    }
}
