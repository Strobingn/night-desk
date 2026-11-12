package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChartMathTest {
    private fun series(n: Int, stepMs: Long = 1_000, f: (Int) -> Double = { 1.0 + it * 0.001 }) =
        List(n) { ChartPoint(1_000_000L + it * stepMs, f(it)) }

    @Test
    fun cleanDropsBadValuesAndBackwardsTime() {
        val raw = listOf(ChartPoint(10, 1.0), ChartPoint(20, Double.NaN), ChartPoint(30, 0.0), ChartPoint(25, 1.2), ChartPoint(40, 1.3), ChartPoint(35, 9.0))
        assertEquals(listOf(ChartPoint(10, 1.0), ChartPoint(25, 1.2), ChartPoint(40, 1.3)), ChartMath.clean(raw))
    }

    @Test
    fun downsampleKeepsEndsAndExtremesAndTimeOrder() {
        val raw = series(2_000) { i -> if (i == 777) 50.0 else if (i == 1_234) 0.01 else 1.0 + (i % 7) * 0.001 }
        val out = ChartMath.downsample(raw, 120)
        assertTrue(out.size <= 120)
        assertEquals(raw.first(), out.first())
        assertEquals(raw.last(), out.last())
        assertTrue(out.any { it.v == 50.0 })
        assertTrue(out.any { it.v == 0.01 })
        assertTrue(out.zipWithNext().all { (a, b) -> a.t < b.t })
        // Short series are returned as they are.
        val short = series(50)
        assertTrue(ChartMath.downsample(short, 120) === short)
    }

    @Test
    fun windowCutsFromTheNewestPoint() {
        val raw = series(7_300) // 1 point per second, a little over two hours
        val hour = ChartMath.window(raw, ChartRange.H1)
        assertEquals(3_601, hour.size)
        assertEquals(raw.last(), hour.last())
        assertTrue(ChartMath.window(raw, ChartRange.ALL) === raw)
        assertTrue(ChartMath.usable(raw, ChartRange.H1))
        // A day window on two hours of data hides nothing, so it is not offered.
        assertFalse(ChartMath.usable(raw, ChartRange.D1))
        assertTrue(ChartMath.usable(raw, ChartRange.ALL))
        assertTrue(ChartMath.window(emptyList(), ChartRange.H1).isEmpty())
    }

    @Test
    fun modelKeepsLevelsOnScreenAndPadsAFlatSeries() {
        val m = ChartMath.model(series(10) { 1.0 }, include = listOf(0.9, Double.NaN, -1.0))
        assertTrue(m.min < 0.9)
        assertTrue(m.max > 1.0)
        assertTrue(m.y(0.9) > 0f && m.y(0.9) < m.y(1.0))
        val flat = ChartMath.model(series(10) { 2.0 })
        assertTrue(flat.max > flat.min)
        assertEquals(0.5f, flat.y(2.0), 0.001f)
        val none = ChartMath.model(emptyList())
        assertTrue(none.empty)
        assertEquals(0.5f, none.y(1.0), 0.5f)
    }

    @Test
    fun xFollowsTimeNotIndex() {
        // Three points: the middle one is 90% of the way through in time.
        val m = ChartMath.model(listOf(ChartPoint(0, 1.0), ChartPoint(900, 1.1), ChartPoint(1_000, 1.2)))
        assertEquals(0f, m.x(0), 0.0001f)
        assertEquals(0.9f, m.x(1), 0.0001f)
        assertEquals(1f, m.x(2), 0.0001f)
        // Same timestamp on every point: fall back to the index.
        val same = ChartMath.model(listOf(ChartPoint(5, 1.0), ChartPoint(5, 1.1), ChartPoint(5, 1.2)))
        assertEquals(0.5f, same.x(1), 0.0001f)
    }

    @Test
    fun nearestFindsThePointUnderTheFinger() {
        val m = ChartMath.model(listOf(ChartPoint(0, 1.0), ChartPoint(900, 1.1), ChartPoint(1_000, 1.2)))
        assertEquals(0, ChartMath.nearest(m, 0.2f))
        assertEquals(1, ChartMath.nearest(m, 0.8f))
        assertEquals(2, ChartMath.nearest(m, 0.97f))
        assertEquals(2, ChartMath.nearest(m, 4f))
        assertEquals(0, ChartMath.nearest(m, -1f))
        assertEquals(-1, ChartMath.nearest(ChartMath.model(emptyList()), 0.5f))
    }

    @Test
    fun labelsReadPlainly() {
        assertEquals("45s", ChartMath.spanLabel(45_000))
        assertEquals("12m", ChartMath.spanLabel(12 * 60_000L + 5_000))
        assertEquals("3h 20m", ChartMath.spanLabel(3 * 3_600_000L + 20 * 60_000L))
        assertEquals("2h", ChartMath.spanLabel(2 * 3_600_000L))
        assertEquals("2d 4h", ChartMath.spanLabel(52 * 3_600_000L))
        assertEquals("+4.20%", ChartMath.pctLabel(1.0, 1.042))
        assertEquals("−12.5%", ChartMath.pctLabel(1.0, 0.875))
        assertEquals("+250%", ChartMath.pctLabel(1.0, 3.5))
        assertEquals("0.00%", ChartMath.pctLabel(1.0, 1.0))
        assertEquals("—", ChartMath.pctLabel(0.0, 1.0))
    }
}
