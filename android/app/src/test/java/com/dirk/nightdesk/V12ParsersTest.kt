package com.dirk.nightdesk

import com.dirk.nightdesk.ui.changedOnly
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V12ParsersTest {
    @Test
    fun sharedTextPicksTheLinkOrMint() {
        assertEquals(
            "https://dexscreener.com/solana/abc123",
            extractSharedCoin("Check this out\nhttps://dexscreener.com/solana/abc123")
        )
        assertEquals(
            "https://pump.fun/coin/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
            extractSharedCoin("(https://pump.fun/coin/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263).")
        )
        assertEquals("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", extractSharedCoin("mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 looks good"))
        assertNull(extractSharedCoin("nothing here"))
        assertNull(extractSharedCoin(null))
    }

    @Test
    fun lookupErrorNeverLooksBuyable() {
        val err = parseLookup("""{"ok":false,"error":"No reliable price for that coin. No buy.","code":"PRICE_UNAVAILABLE"}""")
        assertFalse(err.ok)
        assertFalse(err.canBuy)
        assertEquals("PRICE_UNAVAILABLE", err.code)
        val zeroPrice = parseLookup("""{"ok":true,"mint":"m","priceUsd":0,"canBuy":true}""")
        assertFalse(zeroPrice.ok)
        assertFalse(parseLookup("<html>").ok)
    }

    @Test
    fun lookupParsesGatesAndSizing() {
        val found = parseLookup(
            """{"ok":true,"mint":"Mint1","symbol":"BONK","name":"Bonk","platform":"pump.fun","tag":"manual · pump.fun",
            "priceUsd":0.00002,"liquidityUsd":50000,"volume1hUsd":12000,"marketCapUsd":null,"ageSeconds":7200,
            "dexscreenerUrl":"https://dexscreener.com/solana/Mint1",
            "checks":[{"code":"MINT_AUTHORITY_ACTIVE","pass":false,"message":"Mint authority live"}],
            "filterPass":false,"hardKills":[{"code":"MINT_AUTHORITY_ACTIVE","message":"Mint authority live"}],
            "analyst":{"score":0.4,"line":0.35,"pass":true},"poolMaxUsd":700,"positionCapUsd":8,"manualMaxUsd":100,
            "cashUsd":60,"maxEntrySlippage":0.03,"held":false,"watching":false,"canBuy":true,"buyBlockedReason":null}"""
        )
        assertTrue(found.ok)
        assertEquals("manual · pump.fun", found.tag)
        assertEquals(1, found.hardKills.size)
        assertNull(found.marketCapUsd)
        assertTrue(found.analystPass)
        assertEquals(60.0, found.sliderMaxUsd, 0.0)
        assertNull(found.buyBlockedReason)
    }

    @Test
    fun stateCarriesV12SizingWatchlistAndTags() {
        val snap = parseDeskPayload(
            """{"mode":"paper","equityUsd":100,"cashUsd":90,"sessionPnlUsd":0,"positionCapUsd":8,"manualMaxUsd":90,"exposureUsd":10,
            "rules":{"maxPositionPct":0.25},"prefs":{"positionSizeUsd":null,"maxExposurePct":0.6,"paperResetUsd":2500},
            "positions":[{"mint":"A","symbol":"AAA","tag":"manual · GMGN"}],
            "watchlist":[{"mint":"W","symbol":"WAT","platform":"DexScreener","addedAt":1,"addedPriceUsd":2,"lastPriceUsd":3,"changePct":0.5,"dexscreenerUrl":"https://dexscreener.com/solana/W"},
                         {"mint":"W","symbol":"DUP"},{"symbol":"no mint"}],
            "lastClientCrash":{"at":1,"version":"v11","brief":"NPE in TapeScreen"}}"""
        )!!
        assertNull(snap.positionSizeUsd)
        assertEquals(0.6, snap.maxExposurePct, 1e-9)
        assertEquals(2500.0, snap.paperResetUsd, 0.0)
        assertEquals(90.0, snap.manualMaxUsd, 0.0)
        assertEquals("manual · GMGN", snap.positions.single().tag)
        assertEquals(1, snap.watchlist.size)
        assertEquals(0.5, snap.watchlist.single().changePct!!, 1e-9)
        assertEquals("NPE in TapeScreen", snap.lastClientCrash)
    }

    @Test
    fun settingsSaveSendsOnlyChangedKeys() {
        val before = mapOf("maxPositionPct" to 8.0, "positionSizeUsd" to null, "autoBuy" to true)
        assertEquals(emptyMap<String, Any?>(), changedOnly(before, before))
        assertEquals(mapOf("maxPositionPct" to 25.0), changedOnly(before, before + ("maxPositionPct" to 25.0)))
        assertEquals(mapOf("positionSizeUsd" to 40.0), changedOnly(before, before + ("positionSizeUsd" to 40.0)))
    }
}
