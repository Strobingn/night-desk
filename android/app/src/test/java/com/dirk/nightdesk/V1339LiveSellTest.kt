package com.dirk.nightdesk

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V1339LiveSellTest {
    @Test fun sellTextShowsNoRouteReasonNotTimeout() {
        val json = JSONObject(
            """{"ok":false,"error":"Liquidity gone, no sell route. Nothing was sent.","code":"LIVE_NOT_SUBMITTED"}"""
        )
        val text = OneTap.sellText("insane", json, false, 800)
        assertTrue(text, text.contains("Liquidity gone, no sell route"))
        assertTrue(text, !text.contains("timeout"))
        assertFalse(text == "insane: timeout")
    }

    @Test fun liveSellAndCloseUseThe45sClient() {
        val src = File("src/main/java/com/dirk/nightdesk/DeskRepository.kt").readText()
        assertTrue("oneTapSell must pick liveHttp when live=true", src.contains("val client = if (live) liveHttp else http"))
        assertTrue(src.contains("sendRaw(\"\$base/api/positions/sell\", body.toString(), client)"))
        assertTrue(src.contains("sendRaw(\"\$base/api/positions/close\", body.toString(), client)"))
        assertTrue("liveHttp stays on the 45s live timer", src.contains("BuyRoute.LIVE_BUY_TIMEOUT_SEC"))
        val buy = File("src/main/java/com/dirk/nightdesk/BuyRoute.kt").readText()
        assertTrue(buy.contains("LIVE_BUY_TIMEOUT_SEC = 45"))
    }

    @Test fun holdingCardShowsLiquidityGoneState() {
        val ui = File("src/main/java/com/dirk/nightdesk/ui/NightDeskApp.kt").readText()
        assertTrue(ui.contains("pos.liquidityNote.isNotBlank()"))
        assertTrue(ui.contains("Text(pos.liquidityNote"))
        val models = File("src/main/java/com/dirk/nightdesk/DeskModels.kt").readText()
        assertTrue(models.contains("val liquidityNote: String = \"\""))
        assertTrue(models.contains("liquidityNote = row.optText(\"liquidityNote\")"))
    }
}
