package com.dirk.nightdesk.pump

import com.dirk.nightdesk.pump.alerts.FullScreenGate
import com.dirk.nightdesk.pump.alerts.LocalAlertEngine
import com.dirk.nightdesk.pump.alerts.LocalRule
import com.dirk.nightdesk.pump.alerts.LocalSample
import com.dirk.nightdesk.pump.alerts.NightMode
import com.dirk.nightdesk.pump.alerts.NightSchedule
import com.dirk.nightdesk.pump.scanner.ScanRow
import com.dirk.nightdesk.pump.scanner.scoreRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsScannerTest {
    @Test
    fun nightWindowWrapsPastMidnight() {
        val schedule = NightSchedule(enabled = true, startMin = 22 * 60, endMin = 7 * 60, brightness = 0.55f)
        assertTrue(NightMode.isNight(schedule, 23, 15))
        assertTrue(NightMode.isNight(schedule, 6, 30))
        assertFalse(NightMode.isNight(schedule, 7, 0))
        assertFalse(NightMode.isNight(schedule, 12, 0))
        assertFalse(NightMode.isNight(schedule.copy(enabled = false), 23, 0))
    }

    @Test
    fun fullScreenFallsBackOnAndroid14WithoutTheGrant() {
        assertEquals("fullscreen", FullScreenGate.resolve(33, false, "fullscreen"))
        assertEquals("heads-up", FullScreenGate.resolve(34, false, "fullscreen"))
        assertEquals("fullscreen", FullScreenGate.resolve(34, true, "fullscreen"))
        assertEquals("silent", FullScreenGate.resolve(34, false, "silent"))
        assertTrue(FullScreenGate.MANAGE_ACTION.contains("FULL_SCREEN_INTENT"))
    }

    @Test
    fun localRuleFiresOncePerCrossing() {
        val engine = LocalAlertEngine(listOf(LocalRule("curve", "curve", 50.0, 5.0, 0, "sound")))
        assertEquals(1, engine.evaluate(LocalSample("m", 1, progressPct = 55.0)).size)
        assertEquals(0, engine.evaluate(LocalSample("m", 2, progressPct = 80.0)).size)
        assertEquals(0, engine.evaluate(LocalSample("m", 3, progressPct = 40.0)).size)
        assertEquals(1, engine.evaluate(LocalSample("m", 4, progressPct = 60.0)).size)
    }

    @Test
    fun rugFlagsScoreZero() {
        val clean = ScanRow("m", 10_000_000_000.0, 100.0, 1.0, 0.0, 40.0, 25.0, 0.0)
        assertEquals(1.0, scoreRow(clean), 0.0001)
        assertEquals(0.0, scoreRow(clean.copy(devHoldingPct = 0.2)), 0.0)
        assertEquals(0.0, scoreRow(clean.copy(top10HoldingPct = 0.4)), 0.0)
        assertEquals(0.0, scoreRow(clean.copy(mintAuthority = "still-set")), 0.0)
        assertEquals(0.0, scoreRow(clean.copy(freezeAuthority = "still-set")), 0.0)
        assertEquals(0.0, scoreRow(clean.copy(creatorDumping = true)), 0.0)
    }
}
