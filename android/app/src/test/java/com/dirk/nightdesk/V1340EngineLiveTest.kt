package com.dirk.nightdesk

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V1340EngineLiveTest {
    private fun row(id: String, signal: String, trades: Int, net: Double, trail: Double? = null, fade: Boolean = false, live: Boolean = false) =
        JSONObject().put("variant", id).put("signal", signal).put("stopPct", if (trail != null) 0.03 else 0.01).put("trades", trades)
            .put("wins", trades / 2).put("winRate", 0.5).put("netUsd", net).put("avgNetUsd", if (trades > 0) net / trades else 0.0)
            .put("open", 0).put("active", false).put("ready", false).put("live", live)
            .apply { if (trail != null) put("trailPct", trail); if (fade) put("fade", true) }

    private fun card(liveVariant: String?, vararg rows: JSONObject) = JSONObject()
        .put("enabled", true).put("targetNetUsd", 3).put("tradeUsd", 50).put("maxOpen", 2).put("readyTrades", 200).put("watching", 1)
        .put("liveVariant", liveVariant ?: JSONObject.NULL)
        .put("live", JSONObject().put("open", 1).put("tradeUsd", 5).put("targetNetUsd", 0.3).put("blocked", JSONObject.NULL))
        .put("variants", JSONArray(rows.toList()))
        .put("note", "Paper results.")

    @Test
    fun labelsTrailingAndFadeVariants() {
        val view = Strategy.parse(card(null, row("launch-1", "launch", 3, 1.0), row("launch-3-t8", "launch", 3, 1.0, 0.08), row("launch-3-t8f", "launch", 3, 1.0, 0.08, fade = true)))!!
        assertEquals("1% stop", Strategy.rules(view.variants[0]))
        assertEquals("3% stop · 8% trail", Strategy.rules(view.variants[1]))
        assertEquals("Launch · 3% stop · 8% trail · fade", Strategy.label(view.variants[2]))
    }

    @Test
    fun topEarnerIsTheHighestNetWithTrades() {
        val view = Strategy.parse(card(null, row("launch-1", "launch", 40, 6.5), row("momentum-3-t8", "momentum", 12, 14.25, 0.08), row("launch-6", "launch", 0, 0.0), row("momentum-1", "momentum", 9, -4.0)))!!
        assertEquals("momentum-3-t8", Strategy.topEarner(view)?.variant)
        val none = Strategy.parse(card(null, row("launch-1", "launch", 4, -1.0), row("launch-3", "launch", 0, 0.0)))!!
        assertNull(Strategy.topEarner(none))
    }

    @Test
    fun parsesLiveStateAndOlderDesks() {
        val live = Strategy.parse(card("launch-3-t8", row("launch-3-t8", "launch", 12, 5.0, 0.08, live = true)))!!
        assertTrue(live.liveSupported)
        assertEquals("launch-3-t8", live.liveVariant)
        assertEquals(1, live.liveOpen)
        assertEquals(5.0, live.liveTradeUsd, 1e-9)
        assertEquals(0.3, live.liveTargetUsd, 1e-9)
        assertEquals("", live.liveBlocked)
        assertTrue(live.variants[0].live)
        val off = Strategy.parse(card(null, row("launch-1", "launch", 1, 1.0)))!!
        assertTrue(off.liveSupported)
        assertEquals("", off.liveVariant)
        val old = Strategy.parse(JSONObject().put("enabled", true).put("variants", JSONArray().put(row("launch-1", "launch", 1, 1.0))))!!
        assertFalse(old.liveSupported)
        assertEquals(0.0, old.variants[0].trailPct, 1e-9)
    }

    @Test
    fun liveWarningNamesTheMoneyAndAThinRecord() {
        val view = Strategy.parse(card(null, row("launch-3-t8", "launch", 12, 5.0, 0.08)))!!
        val text = Strategy.liveWarning(view, view.variants[0])
        assertTrue(text.contains("real money"))
        assertTrue(text.contains("$5.00 a trade"))
        assertTrue(text.contains("$0.30 net"))
        assertTrue(text.contains("12 paper trades"))
        assertTrue(text.contains("under the 200 trades"))
    }
}
