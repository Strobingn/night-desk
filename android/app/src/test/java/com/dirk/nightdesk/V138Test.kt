package com.dirk.nightdesk

import com.dirk.nightdesk.ui.stopBarModel
import org.junit.Assert.assertEquals
import org.junit.Test

/** v13.8 tiny prices, the stop label and the card's source · age line. */
class V138Test {
    @Test fun tinyPricesKeepFourSignificantDigits() {
        assertEquals("0.0₁₀4194", PriceText.px(4.194341397423741e-11))
        assertEquals("0.0₁₀4143", PriceText.px(4.143e-11))
        assertEquals("0.0₁₀4069", PriceText.px(4.0685111555010286e-11))
        assertEquals("0.0₅8414", PriceText.px(8.41406416135225e-6))
        assertEquals("0.001235", PriceText.px(0.00123456))
        assertEquals("1.5000", PriceText.px(1.5))
        assertEquals("—", PriceText.px(Double.NaN))
    }

    @Test fun stopLabelSaysLevelAndDistance() {
        val entry = 4.194341397423741e-11
        val m = stopBarModel(entry * 0.97, entry, 4.143e-11, entry, 0.8, true)
        assertEquals("Stop −3.0% · 1.8% away", m.label)
    }

    @Test fun sourceAndAge() {
        assertEquals("on-chain · 0.3s", sourceAgeLabel("chain", 300))
        assertEquals("DexScreener · 12s", sourceAgeLabel("dexscreener", 12_400))
        assertEquals("Jupiter · 2m", sourceAgeLabel("jupiter", 125_000))
    }
}
