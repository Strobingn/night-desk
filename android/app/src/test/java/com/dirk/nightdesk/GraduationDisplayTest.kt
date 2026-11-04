package com.dirk.nightdesk

import com.dirk.nightdesk.graduation.MigrationView
import com.dirk.nightdesk.graduation.migrationLines
import com.dirk.nightdesk.sniper.approvalPayload
import com.dirk.nightdesk.sniper.sniperNotification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GraduationDisplayTest {
    @Test
    fun canonicalPoolReadsAsFullyBurnedAndLocked() {
        val lines = migrationLines(
            MigrationView(
                venue = "pumpswap",
                poolClass = "canonical",
                lpSupply = "1000000",
                lpBurnedPct = 100.0,
                locked = true,
                stillLocked = true,
                owners = listOf("burned 100%")
            )
        )
        assertTrue(lines.any { it.contains("LP burned 100%") })
        assertTrue(lines.any { it.contains("still locked") })
        assertTrue(lines.any { it.contains("canonical") })
    }

    @Test
    fun nonCanonicalIsNamedAndALiveBuyIsOneAck() {
        val text = sniperNotification("watching", "Mint111111111111111111111111111111111111", "non-canonical", "non-canonical pool — not sniped")
        assertTrue(text.contains("non-canonical, not sniped"))
        assertEquals("""{"mint":"Mint","result":"filled"}""", approvalPayload("Mint"))
    }
}
