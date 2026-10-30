package com.dirk.nightdesk

import com.dirk.nightdesk.ui.Palettes
import com.dirk.nightdesk.ui.ThemePref
import com.dirk.nightdesk.ui.ThemeState
import com.dirk.nightdesk.ui.stopBarModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.compose.ui.graphics.toArgb

class V13DesignTest {
    private fun ev(ts: Long, stage: String, kind: String, msg: String, mint: String = "M1", sym: String = "AAA", detail: String? = null) =
        TapeEvent("$ts$stage", ts, stage, kind, msg, null, mint, sym, detail)

    @Test fun themeDefaultsToDarkAndCycles() {
        assertEquals(ThemePref.DARK, ThemeState.parse(null))
        assertEquals(ThemePref.DARK, ThemeState.parse("junk"))
        assertEquals(ThemePref.LIGHT, ThemeState.parse("LIGHT"))
        assertEquals(ThemePref.LIGHT, ThemeState.next(ThemePref.DARK))
        assertEquals(ThemePref.SYSTEM, ThemeState.next(ThemePref.LIGHT))
        assertEquals(ThemePref.DARK, ThemeState.next(ThemePref.SYSTEM))
    }

    @Test fun systemFollowsThePhone() {
        assertTrue(ThemeState.resolve(ThemePref.SYSTEM, true).isDark)
        assertFalse(ThemeState.resolve(ThemePref.SYSTEM, false).isDark)
        assertTrue(ThemeState.resolve(ThemePref.DARK, false).isDark)
        assertFalse(ThemeState.resolve(ThemePref.LIGHT, true).isDark)
    }

    @Test fun darkPaletteIsTheApprovedOne() {
        val d = Palettes.Dark
        assertEquals(0xFF22E07A.toInt(), d.up.toArgb())
        assertEquals(0xFFFF4D5E.toInt(), d.down.toArgb())
        assertEquals(0xFF22D3EE.toInt(), d.accent.toArgb())
        assertEquals(0xFF161616.toInt(), d.card.toArgb())
        assertTrue(d.isDark); assertFalse(Palettes.Light.isDark)
    }

    @Test fun coinCardsFoldVerdicts() {
        val events = listOf(
            ev(1, "scout", "seen", "New pair AAA. Mark 0.0012, 1h volume \$12,345.", detail = "pump"),
            ev(2, "analyst", "pass", "Analyst scored 0.81.", detail = "0.81"),
            ev(3, "scout", "seen", "New pair BBB. Mark 0.5, 1h volume \$900.", mint = "M2", sym = "BBB"),
            ev(4, "filter", "reject", "Filter killed BBB. Top 10 too high.", mint = "M2", sym = "BBB", detail = "top10, lp"),
            ev(5, "scout", "seen", "New pair CCC. Mark 1, 1h volume \$1.", mint = "M3", sym = "CCC")
        )
        val cards = coinCards(events, setOf("M3"))
        assertEquals(listOf("M3", "M2", "M1"), cards.map { it.mint })
        val a = cards.first { it.mint == "M1" }
        assertEquals(Verdict.TRADE, a.verdict); assertEquals(0.81, a.score!!, 1e-9); assertEquals(12345.0, a.vol1h!!, 1e-9); assertEquals("pump", a.source)
        val b = cards.first { it.mint == "M2" }
        assertEquals(Verdict.KILLED, b.verdict); assertEquals(listOf("top10", "lp"), b.codes); assertEquals("Top 10 too high.", b.reason)
        assertEquals(Verdict.OPEN, cards.first().verdict)
    }

    @Test fun dayBaseUsesLastPointBeforeMidnight() {
        val pts = listOf(EquityPoint(10, 100.0), EquityPoint(20, 90.0), EquityPoint(30, 95.0))
        assertEquals(90.0, dayBase(pts, 100.0, 25), 1e-9)
        assertEquals(100.0, dayBase(pts, 50.0, 5), 1e-9)
        assertEquals(50.0, dayBase(emptyList(), 50.0, 5), 1e-9)
    }

    @Test fun stopBarFlagsNearStopAndTrail() {
        val near = stopBarModel(stop = 0.94, entry = 1.0, mark = 0.95, peak = 1.0, armPct = 0.12, trailOn = true)
        assertTrue(near.nearStop); assertEquals("Trail arms +12%", near.right)
        val armed = stopBarModel(stop = 0.94, entry = 1.0, mark = 1.2, peak = 1.25, armPct = 0.12, trailOn = true)
        assertFalse(armed.nearStop); assertEquals("Trailing", armed.right)
        assertEquals("Trail off · +12%", stopBarModel(0.94, 1.0, 1.0, 1.0, 0.12, false).right)
    }
}
