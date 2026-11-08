package com.dirk.nightdesk

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** v13.5 live wallet: live size, wallet card parsing, LIVE labels, and the settings payload. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V135LiveTest {
    private fun state(mode: String, wallet: String?, prefs: String = """{"liveTradeUsd":5,"liveDailyCapUsd":null,"liveTrailPct":0.01}"""): String =
        """{"mode":"$mode","cashUsd":100,"equityUsd":100,"positions":[],"events":[],"closed":[],"rules":{"stopLossPct":0.06,"maxEntrySlippage":0.085},"prefs":$prefs""" +
            (if (wallet != null) ""","wallet":$wallet""" else "") + "}"

    @Test fun liveDeskAlwaysTapsTheLiveSize() {
        assertEquals(5.0, OneTap.effectiveTapUsd("live", 1223.0, 5.0), 0.0)
        assertEquals(7.0, OneTap.effectiveTapUsd("live", 1223.0, 7.0), 0.0)
        assertEquals(5.0, OneTap.effectiveTapUsd("live", 1223.0, null), 0.0)
        assertEquals(1223.0, OneTap.effectiveTapUsd("paper", 1223.0, 5.0), 0.0)
    }

    @Test fun parsesLiveSettingsAndWalletWithoutSecrets() {
        val wallet = """{"keyLoaded":true,"keySource":"env","keyInvalid":false,"publicKey":"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin","solBalance":0.25,"usdcBalance":40.5,"balanceAt":1730000000000,"balanceError":null,"live":false,"liveRequested":false,"rpcPublic":true,"liveSpentTodayUsd":0,"minFeeSol":0.005}"""
        val snap = parseDeskPayload(state("paper", wallet))!!
        assertEquals(5.0, snap.liveTradeUsd, 0.0)
        assertNull(snap.liveDailyCapUsd)
        assertEquals(0.01, snap.liveTrailPct, 1e-9)
        val w = snap.wallet!!
        assertTrue(w.keyLoaded)
        assertEquals("env", w.keySource)
        assertEquals(0.25, w.solBalance!!, 0.0)
        assertEquals(40.5, w.usdcBalance!!, 0.0)
        assertNull(w.balanceError)
        assertFalse(w.live)
        assertEquals("9xQe…VFin", OneTap.shortAddress(w.publicKey))
        val lines = OneTap.walletLines(w, "paper")
        assertTrue(lines.toString(), lines[0].startsWith("Key loaded: yes (WALLET_PRIVATE_KEY)"))
        assertTrue(lines.any { it.startsWith("LIVE is OFF") })
        assertTrue(lines.any { it.contains("public Solana RPC") })
    }

    @Test fun walletLinesSayWhatToFillWhenNoKey() {
        val none = parseWallet(JSONObject("""{"keyLoaded":false,"keyInvalid":false,"publicKey":null,"live":false,"liveRequested":false,"rpcPublic":false}"""))!!
        assertTrue(OneTap.walletLines(none, "paper")[0].contains("Set WALLET_PRIVATE_KEY on the desk host"))
        val bad = parseWallet(JSONObject("""{"keyLoaded":false,"keyInvalid":true,"live":false,"liveRequested":true}"""))!!
        val lines = OneTap.walletLines(bad, "paper")
        assertTrue(lines[0].contains("not a Solana private key"))
        assertTrue(lines.any { it.contains("could not arm") })
        assertEquals("—", OneTap.shortAddress(null))
        assertNull(parseDeskPayload(state("paper", null))!!.wallet)
    }

    @Test fun liveCapAndTrailParse() {
        val snap = parseDeskPayload(state("live", null, """{"liveTradeUsd":12,"liveDailyCapUsd":60,"liveTrailPct":1.5}"""))!!
        assertEquals(12.0, snap.liveTradeUsd, 0.0)
        assertEquals(60.0, snap.liveDailyCapUsd!!, 0.0)
        assertEquals(0.015, snap.liveTrailPct, 1e-9)
    }

    @Test fun liveToastsAndButtonsSayLive() {
        val ok = JSONObject("""{"ok":true,"symbol":"TAP","sizeUsd":5,"mode":"live"}""")
        assertTrue(OneTap.buyText("TAP", ok, true, 900).contains("· LIVE · 900 ms"))
        val ui = com.dirk.nightdesk.ui.OneTapUi(
            tapUsd = 5.0, capUsd = 5.0, maxUsd = 5.0, slipPct = 8.5, stopPct = 0.06, tapping = emptySet(), openCount = 0,
            onBuy = { _, _ -> }, onSell = { _, _ -> }, onSellAll = {}, onTapUsd = {}, onSlip = {}, live = true
        )
        assertEquals("⚡ Buy \$5.00 LIVE", ui.buyLabel)
        assertEquals("⚡ Sell now LIVE", ui.sellLabel)
        val paper = com.dirk.nightdesk.ui.OneTapUi(
            tapUsd = 1223.0, capUsd = 5.0, maxUsd = 5.0, slipPct = 8.5, stopPct = 0.06, tapping = emptySet(), openCount = 0,
            onBuy = { _, _ -> }, onSell = { _, _ -> }, onSellAll = {}, onTapUsd = {}, onSlip = {}
        )
        assertEquals("⚡ Buy \$1223", paper.buyLabel)
        assertEquals("⚡ Sell now", paper.sellLabel)
    }

    @Test fun settingsScreenSavesTheLiveKeys() {
        val kt = File("src/main/java/com/dirk/nightdesk/ui/SettingsScreen.kt").readText()
        val payload = kt.substring(kt.indexOf("private fun payload"), kt.indexOf("private val GROUP_META"))
        for (key in listOf("liveTradeUsd", "liveDailyCapUsd", "liveTrailPct")) assertTrue(key, payload.contains("\"$key\" to"))
        assertTrue(kt.contains("Group(\"Live wallet\")"))
        assertTrue("live size slider goes to \$100", kt.contains("draft.liveUsd, 1f..100f"))
        assertFalse("the phone never sends LIVE_TRADING", payload.contains("LIVE_TRADING"))
        assertFalse("the phone never sends a key", payload.contains("PRIVATE_KEY"))
    }
}
