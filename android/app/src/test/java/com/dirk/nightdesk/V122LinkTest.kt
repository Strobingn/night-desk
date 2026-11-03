package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V122LinkTest {
    private val dead = "https://able-muslim-examines-disposition.trycloudflare.com"
    private val live = "https://fever-solved-permissions-variations.trycloudflare.com"

    @Test
    fun theUrlThatLastWorkedComesBeforeAStaleBeacon() {
        val order = candidateUrls(DeskLink("", ""), beaconUrl = dead, lastGood = live, discovered = null)
        assertEquals(live, order[0].baseUrl)
        assertEquals("last", order[0].source)
        assertEquals(dead, order[1].baseUrl)
        assertEquals(DeskBeacon.LAN_URL, order.first { it.source == "lan" }.baseUrl)
    }

    @Test
    fun aManualUrlStaysFirstAndTheBeaconIsOnlyAFallback() {
        val order = candidateUrls(DeskLink("$live/", "", useManual = true), beaconUrl = dead, lastGood = dead, discovered = null)
        assertEquals(listOf(live, dead), order.take(2).map { it.baseUrl })
        assertEquals(order.size, order.map { it.baseUrl }.toSet().size)
    }

    @Test
    fun aSavedLinkUrlWinsEvenWithoutTheManualSwitch() {
        val order = candidateUrls(DeskLink(live, "", useManual = false), beaconUrl = dead, lastGood = dead, discovered = null)
        assertEquals("saved", order[0].source)
        assertEquals(live, order[0].baseUrl)
        assertEquals(dead, order[1].baseUrl)
        assertEquals(2, order.indexOfFirst { it.source == "lan" })
    }

    @Test
    fun theDeskReportedUrlIsTriedBeforeTheBeacon() {
        val order = candidateUrls(DeskLink("", ""), beaconUrl = dead, lastGood = null, discovered = live)
        assertEquals("desk", order[0].source)
        assertEquals(live, order[0].baseUrl)
    }

    @Test
    fun picksTheFirstCandidateThatAnswersEvenWhenTheBeaconIsDead() {
        val order = candidateUrls(DeskLink("", ""), beaconUrl = dead, lastGood = null, discovered = null)
        val answered = setOf(live, DeskBeacon.LAN_URL)
        // Fresh install: beacon dead, the default (new tunnel) answers.
        assertEquals(DeskBeacon.LAN_URL, order.first { it.baseUrl in answered }.baseUrl)
        assertEquals(live, DeskBeacon.DEFAULT_PUBLIC_URL)
    }

    @Test
    fun readsOnlyATrycloudflareUrlFromHealth() {
        assertEquals(live, parseHealthPublicUrl("""{"ok":true,"mode":"paper","publicUrl":"$live/"}"""))
        assertNull(parseHealthPublicUrl("""{"ok":true,"mode":"paper","publicUrl":"https://evil.example.com"}"""))
        assertNull(parseHealthPublicUrl("""{"ok":true,"mode":"paper","publicUrl":null}"""))
        assertNull(parseHealthPublicUrl("""{"ok":false,"publicUrl":"$live"}"""))
        assertNull(parseHealthPublicUrl("not json"))
    }
}
