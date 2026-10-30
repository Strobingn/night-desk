package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V121FeedTest {
    private val payload = """
        {"equityUsd":100,"cashUsd":80,"mode":"paper",
         "feed":{"pumpConnected":true,"lastError":"GeckoTerminal failing for 3 min (HTTP 429)","sources":[
           {"id":"pump","label":"Pump stream","enabled":true,"state":"live","retryAt":null,"reqPerMin":0,"budgetPerMin":null,"sightingsPerMin":31},
           {"id":"gecko","label":"GeckoTerminal","enabled":true,"state":"backoff","detail":"HTTP 429","retryAt":1000095000,"reqPerMin":3,"budgetPerMin":4,"sightingsPerMin":0},
           {"id":"dexpaprika","label":"DexPaprika","enabled":true,"state":"down","detail":"endpoint removed (HTTP 410)","retryAt":null,"reqPerMin":0,"budgetPerMin":8,"sightingsPerMin":0},
           {"id":"bitquery","label":"Bitquery","enabled":false,"state":"off","detail":"no API key","retryAt":null,"reqPerMin":0,"budgetPerMin":8,"sightingsPerMin":0}
         ]}}
    """.trimIndent()

    @Test
    fun parsesEverySourceAndTheDebouncedBanner() {
        val snap = parseDeskPayload(payload)
        assertNotNull(snap)
        assertEquals(listOf("pump", "gecko", "dexpaprika", "bitquery"), snap!!.feedSources.map { it.id })
        assertEquals("GeckoTerminal failing for 3 min (HTTP 429)", snap.feedBanner)
        assertEquals(1000095000L, snap.feedSources[1].retryAt)
        assertEquals(4, snap.feedSources[1].budgetPerMin)
        assertNull(snap.feedSources[0].budgetPerMin)
    }

    @Test
    fun stateTextShowsCountdownDownAndOff() {
        val snap = parseDeskPayload(payload)!!
        val now = 1000095000L - 42_000L
        assertEquals("live · websocket", feedSourceStateText(snap.feedSources[0], now))
        assertEquals("backing off · retry in 42s · HTTP 429", feedSourceStateText(snap.feedSources[1], now))
        assertEquals("backing off · retry in 1:30 · HTTP 429", feedSourceStateText(snap.feedSources[1], 1000095000L - 90_000L))
        assertEquals("down · endpoint removed (HTTP 410)", feedSourceStateText(snap.feedSources[2], now))
        assertEquals("off · no API key", feedSourceStateText(snap.feedSources[3], now))
        assertEquals("31/min new", feedSourceRateText(snap.feedSources[0]))
        assertEquals("3/4 req/min", feedSourceRateText(snap.feedSources[1]))
    }

    @Test
    fun anOlderDeskWithoutSourcesShowsNoCardAndNoBanner() {
        val snap = parseDeskPayload("""{"equityUsd":100,"cashUsd":100,"feed":{"pumpConnected":true}}""")!!
        assertTrue(snap.feedSources.isEmpty())
        assertNull(snap.feedBanner)
    }
}
