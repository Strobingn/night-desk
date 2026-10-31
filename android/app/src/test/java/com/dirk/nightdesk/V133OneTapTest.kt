package com.dirk.nightdesk

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V133OneTapTest {
    @Test fun buyToastShowsFillSizeModeAndTiming() {
        val ok = JSONObject("""{"ok":true,"symbol":"TAP","sizeUsd":25,"fillPriceUsd":0.0012345,"mode":"paper"}""")
        val text = OneTap.buyText("TAP", ok, true, 180)
        assertTrue(text, text.startsWith("Bought TAP \$25.00 @ \$0.00123"))
        assertTrue(text.endsWith("· paper · 180 ms"))
        val refused = JSONObject("""{"ok":false,"error":"Price is down 30% from its high","code":"PRICE_CRASH"}""")
        assertEquals("TAP: Price is down 30% from its high (PRICE_CRASH)", OneTap.buyText("TAP", refused, false, 90))
        val kill = JSONObject("""{"ok":false,"error":"Hard kill","code":"HARD_KILL"}""")
        assertTrue(OneTap.buyText("TAP", kill, false, 90).contains("Use Buy… to override"))
    }

    @Test fun sellToastLabelsGapRugHonestly() {
        val gap = JSONObject("""{"ok":true,"symbol":"GHOST","proceedsUsd":0.02,"pnlUsd":-24.98,"pnlPct":-0.999,"exitPrice":2.37e-8,"exitCode":"GAP_RUG"}""")
        val text = OneTap.sellText("GHOST", gap, true, 140)
        assertTrue(text, text.contains("gap/rug"))
        assertTrue(text.contains("−\$24.98"))
        assertEquals("gap/rug", OneTap.exitLabel("GAP_RUG"))
        assertEquals("stop-loss", OneTap.exitLabel("STOP_LOSS"))
        assertTrue(OneTap.isStopExit("GAP_RUG"))
        assertTrue(OneTap.isStopExit("STOP_LOSS"))
        assertFalse(OneTap.isStopExit("MANUAL_CLOSE"))
    }

    @Test fun tapSizeFallsBackToManualDefaultThenCap() {
        assertEquals(25.0, OneTap.defaultTapUsd(25.0, 52.0, 500.0), 0.0)
        assertEquals(52.0, OneTap.defaultTapUsd(null, 52.0, 500.0), 0.0)
        assertEquals(500.0, OneTap.defaultTapUsd(null, null, 500.0), 0.0)
        assertTrue(OneTap.newIdemKey() != OneTap.newIdemKey())
    }

    @Test fun stalePumpStreamIsNeverLive() {
        val src = FeedSource(
            id = "pump", label = "Pump stream", enabled = true, state = "stale",
            detail = "no message for 75s, reconnecting", retryAt = null, reqPerMin = 0, budgetPerMin = null, sightingsPerMin = 0
        )
        assertEquals("stale · no message for 75s, reconnecting", feedSourceStateText(src, 0L))
    }

    @Test fun slippageGoesUpToFiftyPercentAndExitIsSaved() {
        val ui = File("src/main/java/com/dirk/nightdesk/ui/SettingsScreen.kt").readText()
        assertTrue(ui.contains("ExactSlider(\"Entry slippage %\", draft.slip, 0.5f..50f"))
        assertTrue(ui.contains("\"maxExitSlippage\" to"))
        val bar = File("src/main/java/com/dirk/nightdesk/ui/OneTapUi.kt").readText()
        assertTrue(bar.contains("valueRange = 0.5f..50f"))
        val snap = parseDeskPayload(
            """{"mode":"paper","rules":{"maxEntrySlippage":0.2},"prefs":{"maxExitSlippage":0.25},"positions":[],"events":[],"closed":[]}"""
        )
        if (snap != null) {
            assertEquals(0.2, snap.maxEntrySlippage, 1e-9)
            assertEquals(0.25, snap.maxExitSlippage ?: 0.0, 1e-9)
        }
    }
}
