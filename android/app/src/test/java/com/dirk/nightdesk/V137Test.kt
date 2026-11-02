package com.dirk.nightdesk

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** v13.7 "Live: manual only · AI: paper": the live book parses apart from the AI's paper book. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V137Test {
    private val pos = """{"mint":"M1","symbol":"AAA","pnlUsd":0.5,"pnlPct":0.1,"markPrice":1.1,"stopPrice":0.94,"entryPrice":1,"costUsd":5,"marketValueUsd":5.5,"openedAt":1,"markAgeMs":0}"""
    private val armed = """{"mode":"live","liveScope":"manual","cashUsd":90,"equityUsd":100,"positions":[$pos],"events":[],"closed":[],
        "rules":{"stopLossPct":0.06},"prefs":{"liveTradeUsd":5,"liveTrailPct":0.05,"liveDailyCapUsd":null,"autoBuy":true,"liveAutoBuy":false},
        "liveBook":{"scope":"manual","line":"Live: manual only · AI: paper.","cashUsd":20,"equityUsd":25.5,"startingUsd":25,"pnlUsd":0.5,"openPnlUsd":0.5,
          "positions":[${pos.replace("\"M1\"", "\"M1\",\"book\":\"live\"")}],"tradeUsd":5,"trailPct":0.05,"dailyCapUsd":null},
        "wallet":{"keyLoaded":true,"keySource":"env","publicKey":"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin","solBalance":0.02,"usdcBalance":20,"live":true,"liveRequested":true,
          "liveScopeLine":"Live: manual only · AI: paper. Your buys are real."}}"""

    @Test fun parsesTwoBooks() {
        val s = parseDeskPayload(armed)!!
        assertEquals("manual", s.liveScope)
        assertFalse(s.liveAutoBuy)
        assertEquals(1, s.positions.size)
        assertFalse(s.positions[0].live)
        val lb = s.liveBook!!
        assertTrue(lb.manualOnly)
        assertEquals(1, lb.positions.size)
        assertTrue(lb.positions[0].live)
        assertEquals(20.0, lb.cashUsd, 0.0)
        assertNull(lb.dailyCapUsd)
        assertEquals(0.05, lb.trailPct, 1e-9)
        assertTrue(OneTap.walletLines(s.wallet, s.mode).any { it.contains("manual only · AI: paper") })
    }

    @Test fun oldDeskHasNoLiveBook() {
        val s = parseDeskPayload("""{"mode":"paper","cashUsd":100,"equityUsd":100,"positions":[],"events":[],"closed":[],"rules":{},"prefs":{}}""")!!
        assertNull(s.liveBook)
        assertNull(s.liveScope)
        assertFalse(s.liveAutoBuy)
    }

    @Test fun marksMergeIntoTheRightBook() {
        val s = parseDeskPayload(armed)!!
        val msg = parseMarksMessage(
            """{"type":"marks","data":{"cashUsd":90,"equityUsd":101,"positions":[{"mint":"M1","markPrice":1.2,"marketValueUsd":6,"pnlUsd":1,"pnlPct":0.2,"stopPrice":0.94,"peakPrice":1.2,"markAgeMs":0}],
              "live":{"cashUsd":20,"equityUsd":24,"positions":[{"mint":"M1","markPrice":0.8,"marketValueUsd":4,"pnlUsd":-1,"pnlPct":-0.2,"stopPrice":0.94,"peakPrice":1.1,"markAgeMs":0}]}}}"""
        )!!
        val m = s.withMarks(msg)
        assertEquals(1.2, m.positions[0].markPrice, 0.0)
        assertEquals(0.8, m.liveBook!!.positions[0].markPrice, 0.0)
        assertEquals(24.0, m.liveBook!!.equityUsd, 0.0)
        assertEquals(-1.0, m.liveBook!!.openPnlUsd, 0.0)
    }

    @Test fun liveSellsNameTheBookAndSettingsSaveTheToggle() {
        val repo = File("src/main/java/com/dirk/nightdesk/DeskRepository.kt").readText()
        assertTrue(repo.contains("if (live) body.put(\"book\", \"live\")"))
        assertTrue(repo.contains("\"sell:live:\$mint\""))
        val settings = File("src/main/java/com/dirk/nightdesk/ui/SettingsScreen.kt").readText()
        assertTrue(settings.contains("\"liveAutoBuy\" to draft.liveAutoBuy"))
        assertTrue(settings.contains("AI buys live too"))
        // existing live controls kept
        assertTrue(settings.contains("Live \$ per trade"))
        assertTrue(settings.contains("Live daily cap"))
        assertTrue(settings.contains("Live trailing stop %"))
        val app = File("src/main/java/com/dirk/nightdesk/ui/NightDeskApp.kt").readText()
        assertTrue(app.contains("LIVE · YOU"))
        assertTrue(app.contains("Sell 100% LIVE"))
        assertNotNull(app.indexOf("\"Paper · AI\"").takeIf { it > 0 })
    }
}
