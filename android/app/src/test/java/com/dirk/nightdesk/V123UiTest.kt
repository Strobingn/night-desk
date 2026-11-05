package com.dirk.nightdesk

import com.dirk.nightdesk.ui.shortConnectionError
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V123UiTest {
    @Test
    fun connectionErrorsBecomeShortPillText() {
        assertEquals(
            "Can't reach able-muslim-examines-disposition",
            shortConnectionError("Unable to resolve host \"able-muslim-examines-disposition.trycloudflare.com\": No address associated with hostname", "Reconnecting")
        )
        assertEquals("Desk is slow to answer · retrying", shortConnectionError("timeout", "Reconnecting"))
        assertEquals("Reconnecting…", shortConnectionError(null, "Reconnecting"))
        assertEquals("HTTP 502", shortConnectionError("HTTP 502", "Live"))
    }
}
