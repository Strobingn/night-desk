package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V1327TapeTest {
    private fun raw(mint: String, enrich: String, seenAt: Long, vol: Double? = 100.0) = RawTapeRow(
        mint = mint,
        symbol = mint,
        name = mint,
        source = "pumpfun",
        seenAt = seenAt,
        priceUsd = 0.001,
        volume1hUsd = vol,
        liquidityUsd = 500.0,
        marketCapUsd = 2_000.0,
        enrich = enrich
    )

    @Test fun newestIsTheDefaultAndRawRowsStayUntilEnrich() {
        assertEquals(TapeSort.NEWEST, TapeSort.parse(null))
        assertEquals(150, TAPE_CARD_CAP)
        val events = listOf(
            TapeEvent("s", 5, "scout", "info", "Scout found OLD on pumpfun. Mark 0.002, 1h volume \$9,000.00.", null, "OLD", "OLD", "pumpfun")
        )
        val cards = coinCards(
            events,
            emptySet(),
            raw = listOf(raw("FRESH", "pending", 9), raw("DROP", "queue_full", 8), raw("OLD", "enriched", 5))
        ).associateBy { it.mint }
        assertEquals("not enriched yet", cards["FRESH"]!!.unenriched)
        assertEquals("not enriched yet / queue full", cards["DROP"]!!.unenriched)
        assertNull(cards["OLD"]!!.unenriched)
        assertEquals(0.001, cards["FRESH"]!!.mark!!, 1e-9)
        assertEquals(100.0, cards["FRESH"]!!.vol1h!!, 1e-9)
        assertEquals("FRESH", cards["FRESH"]!!.event.symbol)
        assertEquals(listOf("FRESH", "DROP", "OLD"), sortCoins(cards.values.toList(), TapeSort.NEWEST).map { it.mint })
        assertTrue(sortCoins(cards.values.toList(), TapeSort.VOLUME).first().mint == "OLD")
    }

    @Test fun parsesRawTapeFromTheSnapshot() {
        val snap = parseDeskPayload(
            """{"mode":"paper","cashUsd":1,"equityUsd":1,"events":[],"rawTape":[
              {"mint":"A","symbol":"AAA","name":"Aye","source":"pumpfun","seenAt":4,"priceUsd":0.2,"volume1hUsd":12,"liquidityUsd":3,"marketCapUsd":9,"enrich":"queue_full"},
              {"mint":"","symbol":"nope"}
            ]}"""
        )!!
        assertEquals(1, snap.rawTape.size)
        assertEquals("queue_full", snap.rawTape[0].enrich)
        assertEquals(0.2, snap.rawTape[0].priceUsd!!, 1e-9)
        assertTrue(parseDeskPayload("""{"mode":"paper","cashUsd":1,"equityUsd":1}""")!!.rawTape.isEmpty())
    }
}
