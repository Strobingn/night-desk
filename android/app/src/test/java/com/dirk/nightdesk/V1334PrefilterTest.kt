package com.dirk.nightdesk

import com.dirk.nightdesk.ui.prefilterLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V1334PrefilterTest {
    @Test
    fun settingsLineKeepsTheCounts() {
        val line = prefilterLine(
            PrefilterStats(
                present = true,
                kills = mapOf("VOLUME_TOO_LOW" to 12, "LIQUIDITY_TOO_THIN" to 3),
                rpcSaved = 45,
                heliusQueue = 2,
                enrichP50 = 800,
                enrichP90 = 1400
            )
        )
        assertTrue(line.contains("VOLUME_TOO_LOW 12"))
        assertTrue(line.contains("RPC saved 45"))
        assertTrue(line.contains("Helius q 2"))
        assertTrue(line.contains("p50 800ms"))
        assertTrue(line.contains("p90 1400ms"))
    }

    @Test
    fun olderDeskHasNoPrefilterBlock() {
        val snap = parseDeskPayload("""{"mode":"paper","cashUsd":100,"equityUsd":100,"sessionPnlUsd":0,"rules":{"minVolume1hUsd":5000,"analystMinScore":0.5,"maxTop10Pct":0.35,"maxPositionPct":0.08,"stopLossPct":0.06,"maxEntrySlippage":0.03},"prefs":{}}""")
        assertFalse(snap!!.prefilter.present)
        assertEquals(0, snap.prefilter.rpcSaved)
    }
}
