package com.dirk.nightdesk

import com.dirk.nightdesk.ui.holderSliderSpec
import com.dirk.nightdesk.ui.settingsQueryMatches
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V1329SettingsTest {
    @Test
    fun minHoldersCapAtTwentyOffHelius() {
        val alchemy = holderSliderSpec("solana-mainnet.g.alchemy.com")
        assertEquals("Min holders of top 20", alchemy.label)
        assertEquals(20f, alchemy.max)
        val missing = holderSliderSpec(null)
        assertEquals(20f, missing.max)
        val helius = holderSliderSpec("mainnet.helius-rpc.com")
        assertEquals("Min holders", helius.label)
        assertEquals(2000f, helius.max)
    }

    @Test
    fun settingsSearchKeepsNamedRows() {
        assertTrue(settingsQueryMatches("", "Link"))
        assertTrue(settingsQueryMatches("link", "Link", "Desk URL, token and beacon"))
        assertTrue(settingsQueryMatches("theme", "Appearance", "theme", "Dark", "Light", "System"))
        assertTrue(settingsQueryMatches("crash", "Crash log"))
        assertTrue(settingsQueryMatches("reset", "Paper book", "Reset book", "paper reset"))
        assertFalse(settingsQueryMatches("theme", "Live wallet", "Live $ per trade"))
        assertTrue(settingsQueryMatches("volume", "Entry / Filter", "1h volume $", "Volume boost %"))
    }
}
