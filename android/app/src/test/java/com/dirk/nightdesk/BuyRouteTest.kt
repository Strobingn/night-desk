package com.dirk.nightdesk

import com.dirk.nightdesk.ui.OneTapUi
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
class BuyRouteTest {
    @Test fun paperButtonNamesPaperEvenWhenTheDeskModeIsLive() {
        val body = BuyRoute.paperOneTap("J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump", 100.0, "paper-button-1")
        assertEquals("paper", body.getString("book"))
        assertEquals(100.0, body.getDouble("sizeUsd"), 0.0)
        assertEquals(true, body.getBoolean("oneTap"))
        assertFalse(body.toString().contains("\"book\":\"live\""))
        val dialog = BuyRoute.paperDialog("J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump", 100.0, false, false, false)
        assertEquals("paper", dialog.getString("book"))
        val ui = OneTapUi(
            tapUsd = 100.0, capUsd = 27.0, maxUsd = 94.52, slipPct = 3.0, stopPct = 0.05, tapping = emptySet(), openCount = 0,
            onBuy = { _, _ -> }, onSell = { _, _ -> }, onSellAll = {}, onTapUsd = {}, onSlip = {},
            live = true, split = true
        )
        assertEquals("⚡ Buy $100", ui.buyLabel)
        assertFalse(ui.buyLabel.contains("LIVE"))
        assertEquals("LIVE BUY $5", ui.liveBuyLabel)
    }

    @Test fun liveStripIsTheOnlyBodyThatNamesLive() {
        val body = BuyRoute.liveOneTap("J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump", 5.0, "live-strip-1")
        assertEquals(
            JSONObject()
                .put("mint", "J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump")
                .put("sizeUsd", 5.0)
                .put("book", "live")
                .put("idemKey", "live-strip-1")
                .put("oneTap", true)
                .toString(),
            body.toString()
        )
        assertTrue(body.toString().contains("\"book\":\"live\""))
    }

    @Test fun liveBuyWaitsLongerThanThePaperClientAndDoesNotSayRetry() {
        assertTrue(BuyRoute.LIVE_BUY_TIMEOUT_SEC > BuyRoute.PAPER_BUY_TIMEOUT_SEC)
        assertEquals(12, BuyRoute.PAPER_BUY_TIMEOUT_SEC)
        assertEquals(45, BuyRoute.LIVE_BUY_TIMEOUT_SEC)
        val note = BuyRoute.liveTimeoutNotice("MI")
        assertTrue(note.contains("may already be submitted"))
        assertFalse(note.contains("retrying"))
    }
}
