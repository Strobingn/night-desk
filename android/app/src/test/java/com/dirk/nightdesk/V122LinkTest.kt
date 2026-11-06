package com.dirk.nightdesk

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
class V122LinkTest {
    private val dead = "https://able-muslim-examines-disposition.trycloudflare.com"
    private val live = "https://fever-solved-permissions-variations.trycloudflare.com"

    @Test
    fun theUrlThatLastWorkedComesBeforeAStaleBeacon() {
        val order = candidateUrls(DeskLink("", ""), beaconUrl = dead, lastGood = live, discovered = null)
        assertEquals(live, order[0].baseUrl)
        assertEquals("last", order[0].source)
        assertEquals(dead, order[1].baseUrl)
        assertTrue(order.none { it.source == "lan" || it.baseUrl.contains(":4721") })
    }

    @Test
    fun aHeldUrlIsTheOnlyCandidate() {
        val order = candidateUrls(DeskLink("$live/", "", useManual = true), beaconUrl = dead, lastGood = dead, discovered = null)
        assertEquals(listOf(live), order.map { it.baseUrl })
        assertEquals("saved", order.single().source)
    }

    @Test
    fun aSavedUrlIsNotProbedAlongsideTheBakedInTunnel() {
        val other = "https://deaths-fridge-portal-neck.trycloudflare.com"
        val order = candidateUrls(DeskLink(other, "secret"), beaconUrl = dead, lastGood = null, discovered = null)
        assertTrue(order.none { it.baseUrl == DeskBeacon.DEFAULT_PUBLIC_URL })
        assertTrue(maySendDeskToken("$other/api/health", other))
        assertFalse(maySendDeskToken("${DeskBeacon.DEFAULT_PUBLIC_URL}/api/health", other))
        assertTrue(maySendDeskToken("${DeskBeacon.DEFAULT_PUBLIC_URL}/api/health", DeskBeacon.DEFAULT_PUBLIC_URL))
    }

    @Test
    fun aSavedLinkUrlWinsEvenWithoutTheManualSwitch() {
        val order = candidateUrls(DeskLink(live, "", useManual = false), beaconUrl = dead, lastGood = dead, discovered = null)
        assertEquals("saved", order[0].source)
        assertEquals(live, order[0].baseUrl)
        assertEquals(dead, order[1].baseUrl)
        assertTrue(order.none { it.source == "lan" })
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
        // Fresh install: beacon dead, the default tunnel is the fallback. No hardcoded :4721.
        assertEquals(live, order.first { it.baseUrl == live }.baseUrl)
        assertTrue(order.none { it.baseUrl.contains(":4721") })
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
