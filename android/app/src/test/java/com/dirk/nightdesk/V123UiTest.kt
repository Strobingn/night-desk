package com.dirk.nightdesk

import com.dirk.nightdesk.ui.shortConnectionError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V123UiTest {
    @Test
    fun connectionErrorsBecomeShortPillText() {
        assertEquals(
            "Can't reach able-muslim-examines-disposition",
            shortConnectionError("Unable to resolve host \"able-muslim-examines-disposition.trycloudflare.com\": No address associated with hostname", "Reconnecting")
        )
        assertEquals("Desk is slow to answer. Do not tap a live buy again until you see a signature or a refusal.", shortConnectionError("timeout", "Reconnecting"))
        assertEquals("Reconnecting…", shortConnectionError(null, "Reconnecting"))
        assertEquals("HTTP 502", shortConnectionError("HTTP 502", "Live"))
    }

    @Test
    fun walletTimeoutDoesNotMarkTheDeskSlowWhenStateIsFine() {
        assertNull(deskLinkError(true, null, "timeout"))
        assertNull(deskLinkError(true, null, "timed out"))
        assertEquals("timeout", deskLinkError(false, "timeout", "HTTP 500"))
        assertEquals("Desk did not answer", deskLinkError(false, "  ", "timeout"))
        assertEquals(
            "Desk is slow to answer. Do not tap a live buy again until you see a signature or a refusal.",
            shortConnectionError(deskLinkError(false, "timeout", null), "Reconnecting")
        )
        val repo = File("src/main/java/com/dirk/nightdesk/DeskRepository.kt").readText()
        assertTrue(repo.contains("walletHttp"))
        assertTrue(repo.contains("pollWallet()"))
        assertTrue(repo.contains("\"\$base/api/wallet\""))
        assertTrue(repo.contains("delay(3_000)"))
        assertTrue(repo.contains("callTimeout(BuyRoute.PAPER_BUY_TIMEOUT_SEC.toLong(), TimeUnit.SECONDS)"))
        assertTrue(repo.contains("deskLinkError(true, null, walletPollError)"))
    }
}
