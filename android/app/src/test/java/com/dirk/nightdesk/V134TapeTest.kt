package com.dirk.nightdesk

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V134TapeTest {
    private fun src(id: String, state: String, perMin: Int = 0) =
        FeedSource(id = id, label = id, enabled = true, state = state, detail = null, retryAt = null, reqPerMin = 0, budgetPerMin = null, sightingsPerMin = perMin)

    @Test fun scoutLineCountsLiveAndShowsDownInRed() {
        val sum = TapeToolbar.scout(listOf(src("pump", "live", 13), src("pumpapi", "down"), src("dex", "live", 30), src("bitquery", "off"), src("jup", "live", 6)))
        assertEquals("3/5 live · 49/min", sum.text)
        assertEquals("1 down", sum.badge)
        val slow = TapeToolbar.scout(listOf(src("pump", "stale"), src("dex", "live")))
        assertEquals("1 slow", slow.badge)
        val blocked = TapeToolbar.scout(listOf(src("pump", "live", 8), src("pumpapi", "blocked")))
        assertEquals("1 blocked", blocked.badge)
        assertNull(TapeToolbar.scout(listOf(src("dex", "live"))).badge)
    }

    @Test fun oneTapChipShowsSizeAndSlip() {
        assertEquals("⚡ \$1223 · slip 8.5%", TapeToolbar.oneTapChip(1223.0, 8.5))
        assertEquals("⚡ \$52.00 · slip 3%", TapeToolbar.oneTapChip(52.0, 3.0))
        assertEquals("↕ Vol", TapeToolbar.sortChip(TapeSort.VOLUME))
        assertEquals("↕ New", TapeToolbar.sortChip(TapeSort.NEWEST))
        assertEquals("↕ Score", TapeToolbar.sortChip(TapeSort.SCORE))
    }

    @Test fun shortPriceKeepsFourSignificantDigits() {
        assertEquals("0.0₅3705", TapeToolbar.shortPrice(0.0000037051234))
        assertEquals("1.235", TapeToolbar.shortPrice(1.23456))
        assertEquals("—", TapeToolbar.shortPrice(Double.NaN))
    }

    @Test fun tapeKeepsEveryControl() {
        val ui = File("src/main/java/com/dirk/nightdesk/ui/NightDeskApp.kt").readText()
        // Sort modes and coin filters live in menus now; the Scout list, one-tap sheet and view toggle stay.
        listOf("TapeSort.entries.forEach", "\"near\" to \"Near miss\"", "\"killed\" to \"Killed\"", "\"trade\" to \"Passed\"", "\"open\" to \"Open\"",
            "ScoutStatusList(feedSources)", "OneTapBar(oneTap)", "\"log\" to \"Raw log\"", "BackHandler { sheetOpen = false }",
            "PREF_SCOUT_OPEN", "\"Buy…\"", "oneTap.buyLabel", "\"⚡ Sell\"").forEach { assertTrue(it, ui.contains(it)) }
    }
}
