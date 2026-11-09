package com.dirk.nightdesk

import com.dirk.nightdesk.ui.ADD_COIN_HELP
import com.dirk.nightdesk.ui.ADD_COIN_LABEL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class V136Test {
    @Test
    fun ambiguousTickerParsesThePickList() {
        val raw = """{"ok":false,"code":"AMBIGUOUS","query":"TAZ","error":"2 coins match “TAZ” (DexScreener search). Tap the one you mean.",
          "candidates":[{"mint":"6FpQSako8NexbSPCj2dJ7W6vVXqA8qLyZ1x8qyjppump","symbol":"TAZ","name":"Taz","mintShort":"6Fpq…pump","liquidityUsd":125291.79,"volume1hUsd":34333.59,"held":true,"origin":"position","exact":true},
          {"mint":"2HNbRAN6m3bhgYb9mCzH6ULoT8qQuTWE3pM1CyM1pump","symbol":"TAZ","name":"Taz copy","mintShort":"2HNb…pump","liquidityUsd":null,"volume1hUsd":7979,"held":false,"origin":"dexscreener","exact":false}]}"""
        val found = parseLookup(raw)
        assertFalse(found.ok)
        assertEquals("AMBIGUOUS", found.code)
        assertEquals(2, found.candidates.size)
        assertEquals("6Fpq…pump · liq $125.3K · 1h vol $34.3K · held", found.candidates[0].line)
        assertTrue(found.candidates[0].held)
        assertEquals("2HNb…pump · liq — · 1h vol $8.0K · DexScreener", found.candidates[1].line)
        assertFalse(found.candidates[1].exact)
    }

    @Test
    fun singleTickerMatchCarriesMatchedBy() {
        val raw = """{"ok":true,"mint":"6FpQSako8NexbSPCj2dJ7W6vVXqA8qLyZ1x8qyjppump","symbol":"QTFALCN","name":"Qatar Falcon","priceUsd":0.037,"liquidityUsd":125000,
          "held":true,"matchedBy":"QTFALCN · held / traded","priceSource":"chain","analyst":{"score":0.4,"line":0.31,"pass":true}}"""
        val found = parseLookup(raw)
        assertTrue(found.ok)
        assertEquals("QTFALCN · held / traded", found.matchedBy)
        assertEquals("chain", found.priceSource)
        assertTrue(found.held)
    }

    @Test
    fun capHintNamesTheExposureCapAndOnlySaysCutWhenCut() {
        val line = "exposure cap: max exposure 35% × \$91.43 equity = \$32.00, minus \$26.03 already in open positions = \$5.97 room"
        assertEquals("cut to \$5.97 by the $line", OneTap.capHint(line, 5.97, 20.0))
        assertEquals("within the \$5.97 cap, set by the $line", OneTap.capHint(line, 5.97, 5.0))
        assertEquals("cut to the \$5.97 cap and cash", OneTap.capHint(null, 5.97, 20.0))
    }

    @Test
    fun searchOneTapNamesPaperAndLiveSeparately() {
        val size = OneTap.splitSizeLine(100.0, 5.0, 0.01, 0.06, false)
        val buy = OneTap.splitBuyLine(100.0, 5.0, "cut to \$24.07 by the exposure cap")
        assertTrue(size, size.contains("Paper one tap \$100"))
        assertTrue(size, size.contains("Live buys \$5"))
        assertFalse(size, size.contains("Live size \$100"))
        assertTrue(buy, buy.contains("Paper one tap buys \$100"))
        assertTrue(buy, buy.contains("Live buttons buy \$5"))
        val chip = OneTap.liveStatusChip("live", true, 5.0, 20.0, 0.0037)
        assertEquals("LIVE ready · \$5/trade · \$20/day · wallet 0.0037 SOL", chip)
        assertFalse(chip.contains("SOLANA_RPC_URL"))
        assertFalse(chip.contains("LIVE_TRADING"))
    }

    @Test
    fun snapshotReadsCapWhy() {
        val raw = """{"type":"snapshot","data":{"mode":"paper","equityUsd":91.43,"cashUsd":65.32,"positionCapUsd":5.97,"capWhy":{"capUsd":5.97,"binding":"exposure","line":"exposure cap: max exposure 35% × ${'$'}91.43 equity"},"positions":[],"closed":[],"events":[],"rules":{},"prefs":{}}}"""
        val snap = parseDeskPayload(raw)!!
        assertEquals("exposure", snap.capBinding)
        assertTrue(snap.capLine!!.startsWith("exposure cap"))
    }

    @Test
    fun curvePricedTapeLineFillsTheMark() {
        val mint = "9dGdEhbke3J8kBNfb3TUmm2qqfVfLZHS7scxxpCNpump"
        val events = listOf(
            TapeEvent("1", 1_000, "scout", "info", "Scout found JEETERS on pumpfun. Mark 0, 1h volume \$0.00.", null, mint, "JEETERS", "pumpfun"),
            TapeEvent("2", 2_000, "scout", "info", "Scout priced JEETERS from its pump.fun bonding curve on-chain. Mark 0.00000451, 1h volume \$0.00, curve depth \$8,520.00.", null, mint, "JEETERS", "pumpfun")
        )
        val card = coinCards(events, emptySet()).first { it.mint == mint }
        assertEquals(4.51e-6, card.mark!!, 1e-12)
    }

    @Test
    fun addCoinFieldSaysTickersWork() {
        assertEquals("Name, symbol, mint or link", ADD_COIN_LABEL)
        assertTrue(ADD_COIN_HELP.contains("symbol"))
        assertTrue(ADD_COIN_HELP.contains("DexScreener search"))
    }
}
