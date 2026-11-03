package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** v13.10 a real price, 5m volume and 1h change on every Tape card, or a short reason. */
@RunWith(RobolectricTestRunner::class)
class V1310Test {
    private fun ev(ts: Long, mint: String, msg: String, detail: String? = null, stage: String = "scout", kind: String = "info") =
        TapeEvent("e$ts", ts, stage, kind, msg, null, mint, mint, detail)

    @Test fun parsesSubscriptPrices() {
        assertEquals(0.00000207, parsePxText("0.0₅207")!!, 1e-15)
        assertEquals(0.000000000004194, parsePxText("0.0₁₁4194")!!, 1e-20)
        assertEquals(0.5, parsePxText("0.5")!!, 1e-12)
        assertNull(parsePxText("0"))
        assertNull(parsePxText("0.0"))
        assertNull(parsePxText("junk"))
    }

    @Test fun scoutLineWithSubscriptMarkIsPriced() {
        val cards = coinCards(listOf(ev(1, "A", "Scout found A on raydium. Mark 0.0₅207, 1h volume \$1,200.50.", "raydium")), emptySet())
        assertEquals(0.00000207, cards[0].mark!!, 1e-15)
        assertEquals(1200.5, cards[0].vol1h!!, 1e-9)
    }

    @Test fun markZeroNeverBecomesAPriceAndKeepsEarlierMark() {
        val cards = coinCards(listOf(
            ev(1, "A", "Scout priced A from its pump.fun bonding curve on-chain. Mark 0.0000052, 1h volume \$0."),
            ev(2, "A", "Scout found A on pumpfun. Mark 0, 1h volume \$0.00.", "pumpfun")
        ), emptySet())
        assertEquals(0.0000052, cards[0].mark!!, 1e-15)
        val none = coinCards(listOf(ev(1, "B", "Scout found B on pumpfun. Mark 0, 1h volume \$0.00.", "pumpfun")), emptySet())
        assertNull(none[0].mark)
        assertEquals("checking…", tapeMissing(none[0], "price"))
    }

    @Test fun liveQuoteWinsOverFrozenSighting() {
        val events = listOf(ev(1, "A", "Scout found A on pumpfun. Mark 0, 1h volume \$0.00.", "pumpfun"))
        val q = mapOf("A" to TapeQuote(0.0000123, 3066.0, 410.0, 12.5, "dexscreener", 5, null))
        val c = coinCards(events, emptySet(), quotes = q)[0]
        assertEquals(0.0000123, c.mark!!, 1e-15)
        assertEquals(3066.0, c.vol1h!!, 1e-9)
        assertEquals(410.0, c.vol5m!!, 1e-9)
        assertEquals(12.5, c.change1h!!, 1e-9)
        assertEquals(1, c.volRank)
    }

    @Test fun missingPriceShowsTheReason() {
        val events = listOf(ev(1, "A", "Scout found A on pumpfun. Mark 0, 1h volume \$0.00.", "pumpfun"))
        val q = mapOf("A" to TapeQuote(null, null, null, null, null, 5, "curve done, no pool yet"))
        val c = coinCards(events, emptySet(), quotes = q)[0]
        assertNull(c.mark)
        assertEquals("curve done, no pool yet", tapeMissing(c, "price"))
        assertEquals("not listed", tapeMissing(c, "vol"))
        val curve = c.copy(mark = 0.00001, why = null, quoteSource = "pump.fun curve")
        assertEquals("curve only", tapeMissing(curve, "chg"))
    }

    @Test fun snapshotParsesTapeQuotesAndDropsZeroPrice() {
        val snap = parseDeskPayload("""{"mode":"paper","cashUsd":1,"equityUsd":1,"tapeQuotes":{
            "A":{"priceUsd":0.00002,"vol1hUsd":100,"vol5mUsd":5,"change1hPct":-3.2,"source":"dexscreener","at":9,"why":null},
            "B":{"priceUsd":0,"vol1hUsd":null,"vol5mUsd":null,"change1hPct":null,"source":null,"at":9,"why":"no pool yet"}}}""")!!
        assertEquals(0.00002, snap.tapeQuotes["A"]!!.priceUsd!!, 1e-12)
        assertEquals(-3.2, snap.tapeQuotes["A"]!!.change1hPct!!, 1e-9)
        assertNull(snap.tapeQuotes["B"]!!.priceUsd)
        assertEquals("no pool yet", snap.tapeQuotes["B"]!!.why)
        assertTrue(parseDeskPayload("""{"mode":"paper","cashUsd":1,"equityUsd":1}""")!!.tapeQuotes.isEmpty())
    }

    @Test fun shortPriceNeverShowsZero() {
        assertEquals("—", TapeToolbar.shortPrice(0.0))
        assertEquals("0.0₅207", TapeToolbar.shortPrice(0.00000207))
    }
}
