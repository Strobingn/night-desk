package com.dirk.nightdesk

import com.dirk.nightdesk.ui.holderSliderSpec
import org.junit.Assert.assertEquals
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
}
