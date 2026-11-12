package com.dirk.nightdesk

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V1330StrategyTest {
    private fun row(variant: String, signal: String, stopPct: Double, trades: Int, netUsd: Double, active: Boolean = false, open: Int = 0) =
        JSONObject()
            .put("variant", variant)
            .put("signal", signal)
            .put("stopPct", stopPct)
            .put("trades", trades)
            .put("wins", trades / 2)
            .put("winRate", if (trades > 0) 0.5 else 0.0)
            .put("avgWinUsd", 3.0)
            .put("avgLossUsd", -0.8)
            .put("netUsd", netUsd)
            .put("avgNetUsd", if (trades > 0) netUsd / trades else 0.0)
            .put("maxDrawdownUsd", 1.6)
            .put("open", open)
            .put("active", active)
            .put("ready", false)

    private fun card(enabled: Boolean = true) = JSONObject()
        .put("enabled", enabled)
        .put("targetNetUsd", 3)
        .put("tradeUsd", 50)
        .put("maxOpen", 2)
        .put("readyTrades", 200)
        .put("watching", 4)
        .put("stats", JSONObject().put("signals", JSONObject().put("launch", 7).put("momentum", 5)))
        .put("note", "Paper results.")
        .put(
            "variants",
            JSONArray()
                .put(row("launch-1", "launch", 0.01, 12, -3.1, active = true))
                .put(row("launch-3", "launch", 0.03, 10, 4.25, open = 1))
                .put(row("momentum-6", "momentum", 0.06, 0, 0.0))
                .put(JSONObject().put("signal", "launch"))
        )

    @Test
    fun olderDeskHasNoEngine() {
        assertNull(Strategy.parse(null))
    }

    @Test
    fun parsesTheScorecard() {
        val view = Strategy.parse(card())!!
        assertTrue(view.enabled)
        assertEquals(50.0, view.tradeUsd, 0.0)
        assertEquals(3.0, view.targetNetUsd, 0.0)
        assertEquals(2, view.maxOpen)
        assertEquals(4, view.watching)
        assertEquals(12, view.signals)
        // A row with no variant id is dropped.
        assertEquals(3, view.variants.size)
        assertTrue(view.variants[0].active)
        assertEquals(-3.1, view.variants[0].netUsd, 1e-9)
        assertEquals(1, view.variants[1].open)
    }

    @Test
    fun labelsAndStatsReadPlainly() {
        val view = Strategy.parse(card())!!
        assertEquals("Launch · 1% stop", Strategy.label(view.variants[0]))
        assertEquals("Momentum · 6% stop", Strategy.label(view.variants[2]))
        assertEquals("12 trades · 50% wins · net −$3.10 · avg −$0.26", Strategy.stats(view.variants[0]))
        assertEquals("10 trades · 50% wins · net +$4.25 · avg +$0.43 · 1 open", Strategy.stats(view.variants[1]))
        assertEquals("No trades yet", Strategy.stats(view.variants[2]))
        val line = Strategy.summary(view)
        assertTrue(line.startsWith("On · paper · $50 a trade · 2 open at most · take-profit $3.00 net"))
        assertTrue(line.contains("watching 4"))
        assertTrue(line.contains("12 signals"))
        assertTrue(Strategy.summary(Strategy.parse(card(enabled = false))!!).startsWith("Off"))
    }

    @Test
    fun steppersStepFromTheValueOnScreenAndStayInBand() {
        // Three quick + taps from $25: each steps from the last value shown, not from the old snapshot.
        var shown = 25.0
        repeat(3) { shown = Strategy.step(shown, 5.0, 5.0, 500.0) }
        assertEquals(40.0, shown, 0.0)
        assertEquals(500.0, Strategy.step(498.0, 5.0, 5.0, 500.0), 0.0)
        assertEquals(5.0, Strategy.step(5.0, -5.0, 5.0, 500.0), 0.0)
        assertEquals(0.25, Strategy.step(0.5, -0.5, 0.25, 50.0), 0.0)
        assertEquals(3.5, Strategy.step(3.0, 0.5, 0.25, 50.0), 0.0)
    }

    @Test
    fun openCountIsTheMainBookNotTheShadowBooks() {
        // The shadow books hold 1; the desk says the main book holds 2.
        val reported = Strategy.parse(card().put("mainOpen", 2))!!
        assertEquals(2, Strategy.mainOpen(reported, emptyList()))
        // After a scorecard reset the shadow books are empty but the main book still holds its trades.
        val wiped = Strategy.parse(card().put("mainOpen", 1).put("variants", JSONArray()))!!
        assertEquals(1, Strategy.mainOpen(wiped, emptyList()))
        // A desk that does not report it: unknown, never the shadow sum.
        val older = Strategy.parse(card())!!
        assertEquals(-1, older.mainOpen)
        assertEquals(0, Strategy.mainOpen(older, emptyList()))
    }

    @Test
    fun engineStopCountsAsAStopForAlerts() {
        assertTrue(OneTap.isStopExit("STRATEGY_STOP"))
        assertFalse(OneTap.isStopExit("TAKE_PROFIT"))
        assertEquals("take-profit", OneTap.exitLabel("TAKE_PROFIT"))
        assertEquals("time limit", OneTap.exitLabel("TIME_LIMIT"))
    }
}
