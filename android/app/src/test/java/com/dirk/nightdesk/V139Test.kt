package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** v13.9 LIVE BUY / LIVE SELL beside a paper position. */
@RunWith(RobolectricTestRunner::class)
class V139Test {
    private val unarmed = """
        {"mode":"paper","cashUsd":900,"equityUsd":1000,"positionCapUsd":100,"liveRequested":true,
         "liveBook":null,"liveNotArmed":"Live not armed: wallet key missing (WALLET_PRIVATE_KEY on Austin is not a private key).",
         "wallet":{"keyLoaded":false,"keyInvalid":true,"live":false},
         "prefs":{"liveTradeUsd":5},
         "rules":{"stopLossPct":0.03},
         "positions":[{"mint":"M1","symbol":"AAA","pnlUsd":1,"pnlPct":0.01,"markPrice":1,"stopPrice":0.97,"entryPrice":1,"score":0.5,"source":"raydium","entry":"analyst","lpUnlocked":false,"markAgeMs":100,"costUsd":50,"marketValueUsd":51}]}
    """.trimIndent()

    private val armed = """
        {"mode":"live","cashUsd":900,"equityUsd":1000,"positionCapUsd":100,"liveRequested":true,"liveNotArmed":null,
         "prefs":{"liveTradeUsd":1},
         "rules":{"stopLossPct":0.03},
         "positions":[{"mint":"M1","symbol":"AAA","pnlUsd":1,"pnlPct":0.01,"markPrice":1,"stopPrice":0.97,"entryPrice":1,"score":0.5,"source":"raydium","entry":"analyst","lpUnlocked":false,"markAgeMs":100,"costUsd":50,"marketValueUsd":51}],
         "liveBook":{"scope":"manual","line":"x","cashUsd":40,"equityUsd":45,"startingUsd":41,"pnlUsd":0.2,"openPnlUsd":0.2,"tradeUsd":5,"trailPct":0.05,"dailyCapUsd":null,
           "positions":[{"mint":"M1","symbol":"AAA","book":"live","pnlUsd":0.2,"pnlPct":0.04,"markPrice":1.04,"stopPrice":0.97,"entryPrice":1,"score":0.5,"source":"raydium","entry":"manual","lpUnlocked":false,"markAgeMs":100,"costUsd":5,"marketValueUsd":5.2}]}}
    """.trimIndent()

    @Test fun labels() {
        assertEquals("LIVE BUY $5", LiveTap.buyLabel(5.0))
        assertEquals("LIVE BUY $1", LiveTap.buyLabel(1.0))
        assertEquals("LIVE BUY $2.50", LiveTap.buyLabel(2.5))
        assertEquals("LIVE BUY $5", LiveTap.buyLabel(Double.NaN))
    }

    @Test fun unarmedDeskShowsPlainMessageAndSendsNothing() {
        val snap = parseDeskPayload(unarmed)!!
        assertEquals("Live not armed: wallet key missing (WALLET_PRIVATE_KEY on Austin is not a private key). Nothing was sent.", LiveTap.block(snap))
        assertEquals(5.0, LiveTap.size(snap), 1e-9)
        assertTrue(LiveTap.held(snap).isEmpty())
        assertEquals("Desk not loaded yet. Nothing was sent.", LiveTap.block(null))
    }

    @Test fun armedDeskUsesLiveBookSizeAndShowsTheLivePosition() {
        val snap = parseDeskPayload(armed)!!
        assertNull(LiveTap.block(snap))
        assertEquals(5.0, LiveTap.size(snap), 1e-9) // the live book's size wins
        val held = LiveTap.held(snap)["M1"]!!
        assertTrue(held.live)
        assertEquals(5.0, held.costUsd, 1e-9)
        assertEquals(1, snap.positions.size) // the paper position is still there
        assertEquals(50.0, snap.positions[0].costUsd, 1e-9)
    }
}
