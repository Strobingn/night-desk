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

class V1341Test {
    @Test
    fun parsesLiveEquityAndDropsBadRows() {
        val rows = JSONArray()
            .put(JSONObject().put("t", 1000).put("equity", 20.5).put("cash", 20.5))
            .put(JSONObject().put("t", 2000).put("cash", 1))
            .put(JSONObject().put("t", 0).put("equity", 9))
            .put(JSONObject().put("t", 3000).put("equity", 22.0))
        val points = parseEquityPoints(rows)
        assertEquals(listOf(1000L, 3000L), points.map { it.t })
        assertEquals(22.0, points.last().equity, 1e-9)
        assertTrue(parseEquityPoints(null).isEmpty())
        val live = parseLiveBook(
            JSONObject().put("scope", "all").put("line", "x").put("cashUsd", 18).put("equityUsd", 22).put("openPnlUsd", 0.4)
                .put("startingUsd", 20).put("pnlUsd", 2).put("equity", rows).put("positions", JSONArray()),
            0L
        )!!
        assertEquals(2, live.equityPoints.size)
        assertEquals(20.0, live.startingUsd, 1e-9)
        assertEquals(2.0, live.pnlUsd, 1e-9)
        val old = parseLiveBook(JSONObject().put("scope", "manual").put("line", "x").put("cashUsd", 1).put("equityUsd", 1).put("positions", JSONArray()), 0L)!!
        assertTrue(old.equityPoints.isEmpty())
    }

    @Test
    fun parsesRecordingAndReplay() {
        val card = JSONObject().put("enabled", true).put("variants", JSONArray())
            .put("recording", JSONObject().put("enabled", true).put("days", 14).put("quotes", 12340).put("signals", 18).put("oldestAt", 5))
        val view = Strategy.parse(card)!!
        assertEquals("Saving market data for analysis: 12,340 quotes and 18 signals, kept 14 days.", Strategy.recordingLine(view))
        assertEquals("", Strategy.recordingLine(Strategy.parse(JSONObject().put("enabled", true).put("variants", JSONArray()))!!))
        val replay = Strategy.parseReplay(
            JSONObject().put("ok", true).put("quotes", 900).put("signals", 31).put("note", "Paper-model results.")
                .put("rows", JSONArray().put(JSONObject().put("signal", "launch").put("label", "3% stop, 8% trail, lock breakeven").put("trades", 31).put("winRate", 0.58).put("netUsd", 12.4).put("avgNetUsd", 0.4).put("maxDrawdownUsd", 4.1)))
                .toString()
        )!!
        assertEquals(1, replay.rows.size)
        assertEquals("Launch · 3% stop, 8% trail, lock breakeven", Strategy.replayTitle(replay.rows[0]))
        assertEquals("+$12.40 over 31 trades · 58% wins · worst dip $4.10", Strategy.replayStats(replay.rows[0]))
        assertNull(Strategy.parseReplay("{\"ok\":false}"))
        assertNull(Strategy.parseReplay("not json"))
    }
}

class V1344LiveWhyTest {
    private val now = 1_800_000_000_000L
    private fun view(live: JSONObject): StrategyView = Strategy.parse(
        JSONObject().put("enabled", true).put("liveVariant", "launch-3").put("live", live.put("tradeUsd", 5).put("targetNetUsd", 0.3).put("open", 0))
            .put("variants", JSONArray().put(JSONObject().put("variant", "launch-3").put("signal", "launch").put("stopPct", 0.03).put("live", true)))
    )!!

    @Test
    fun deadHoldingsAreShownApartFromOpenOnes() {
        val live = { JSONObject().put("blocked", JSONObject.NULL).put("since", now).put("signals", 0).put("otherSignals", 0).put("buys", 0) }
        assertEquals("0 open now.", Strategy.liveOpenLine(view(live())))
        // view() sets open after the caller's fields, so put dead only.
        assertEquals("0 open now. 6 dead (no sell route), not counted against the engine's limit.", Strategy.liveOpenLine(view(live().put("dead", 6))))
    }

    @Test
    fun saysWhyLiveHasNotBought() {
        val base = { JSONObject().put("blocked", JSONObject.NULL).put("since", now - 3 * 3_600_000L).put("signals", 0).put("otherSignals", 0).put("buys", 0) }
        assertEquals("No signal has fired since 3 h ago. Live buys only happen on a signal.", Strategy.liveStatus(view(base()), now))
        assertEquals(
            "No launch signal has fired since 3 h ago. 4 of the other kind fired, which this variant does not trade.",
            Strategy.liveStatus(view(base().put("otherSignals", 4)), now)
        )
        val refused = base().put("signals", 2).put("lastSkip", JSONObject().put("at", now - 120_000).put("symbol", "PEPE").put("code", "LIVE_WALLET").put("message", "Wallet has 0.0100 SOL. This pump buy needs about 0.0340 SOL ($5.00 plus fees)."))
        assertEquals("Last live attempt (2 min ago): PEPE was refused. Wallet has 0.0100 SOL. This pump buy needs about 0.0340 SOL ($5.00 plus fees).", Strategy.liveStatus(view(refused), now))
        val capped = base().put("signals", 5).put("buys", 4).put("lastBuyAt", now - 60_000).put("spentTodayUsd", 20).put("dailyCapUsd", 20)
        assertTrue(Strategy.liveStatus(view(capped), now).startsWith("Daily live cap reached: $20.00 of $20.00"))
        val bought = base().put("signals", 3).put("buys", 2).put("lastBuyAt", now - 30_000).put("lastSkip", JSONObject().put("at", now - 600_000).put("symbol", "X").put("message", "old"))
        assertEquals("2 live buys so far, the last just now.", Strategy.liveStatus(view(bought), now))
        // The desk's own block line already explains it; an older desk reports nothing.
        assertEquals("", Strategy.liveStatus(view(base().put("blocked", "The live checklist (operatorReady) is not marked.")), now))
        assertEquals("", Strategy.liveStatus(view(JSONObject().put("blocked", JSONObject.NULL)), now))
    }
}
