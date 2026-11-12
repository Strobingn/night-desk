package com.dirk.nightdesk

import java.util.Locale

/** One point on a chart: a time in epoch ms and a value (a price or an equity). */
data class ChartPoint(val t: Long, val v: Double)

/** Time windows for the performance chart. `ms` null means everything the desk sent. */
enum class ChartRange(val label: String, val ms: Long?) {
    H1("1H", 3_600_000L),
    H6("6H", 6 * 3_600_000L),
    D1("1D", 24 * 3_600_000L),
    ALL("All", null)
}

/** What the chart draws, worked out once per data change instead of on every frame. */
data class ChartModel(
    val points: List<ChartPoint>,
    val min: Double,
    val max: Double,
    val t0: Long,
    val t1: Long
) {
    val empty: Boolean get() = points.isEmpty()
    val first: Double get() = points.firstOrNull()?.v ?: 0.0
    val last: Double get() = points.lastOrNull()?.v ?: 0.0
    val spanMs: Long get() = (t1 - t0).coerceAtLeast(0L)

    /** 0..1 across the width. Falls back to the point's index when every point has the same time. */
    fun x(index: Int): Float {
        if (points.size < 2) return 1f
        return if (t1 > t0) ((points[index].t - t0).toDouble() / (t1 - t0).toDouble()).toFloat().coerceIn(0f, 1f)
        else index.toFloat() / (points.size - 1).toFloat()
    }

    /** 0 at the bottom of the plot, 1 at the top. */
    fun y(value: Double): Float {
        val span = max - min
        if (!(span > 0.0) || !value.isFinite()) return 0.5f
        return ((value - min) / span).toFloat().coerceIn(0f, 1f)
    }
}

object ChartMath {
    /** Most points a chart draws. A phone chart is a few hundred pixels wide; more is wasted work. */
    const val MAX_POINTS = 120

    /** Drops points that cannot be drawn and keeps time moving forward. */
    fun clean(points: List<ChartPoint>): List<ChartPoint> {
        val out = ArrayList<ChartPoint>(points.size)
        var lastT = Long.MIN_VALUE
        for (p in points) {
            if (!p.v.isFinite() || p.v <= 0.0) continue
            if (p.t < lastT) continue
            out.add(p)
            lastT = p.t
        }
        return out
    }

    /**
     * At most `max` points. Each bucket keeps its lowest and highest point in time order, so a
     * wick or a dip survives; the first and last points are always kept.
     */
    fun downsample(points: List<ChartPoint>, max: Int = MAX_POINTS): List<ChartPoint> {
        if (points.size <= max || max < 4) return points
        val inner = points.subList(1, points.size - 1)
        val buckets = (max - 2) / 2
        val out = ArrayList<ChartPoint>(max)
        out.add(points.first())
        for (b in 0 until buckets) {
            val from = (b.toLong() * inner.size / buckets).toInt()
            val to = ((b + 1).toLong() * inner.size / buckets).toInt()
            if (to <= from) continue
            var lo = from
            var hi = from
            for (i in from until to) {
                if (inner[i].v < inner[lo].v) lo = i
                if (inner[i].v > inner[hi].v) hi = i
            }
            if (lo == hi) out.add(inner[lo])
            else if (lo < hi) { out.add(inner[lo]); out.add(inner[hi]) }
            else { out.add(inner[hi]); out.add(inner[lo]) }
        }
        out.add(points.last())
        return out
    }

    /** The points inside a time window ending at the newest point. */
    fun window(points: List<ChartPoint>, range: ChartRange): List<ChartPoint> {
        val ms = range.ms ?: return points
        val end = points.lastOrNull()?.t ?: return points
        val from = end - ms
        val start = points.indexOfFirst { it.t >= from }
        return if (start <= 0) points else points.subList(start, points.size)
    }

    /** A range is worth offering when it holds at least three points and hides some of the history. */
    fun usable(points: List<ChartPoint>, range: ChartRange): Boolean {
        if (range.ms == null) return true
        val cut = window(points, range)
        return cut.size >= 3 && cut.size < points.size
    }

    /**
     * Builds the model. `include` are levels that must stay on screen (entry, stop, start balance);
     * ones that are not finite or not positive are ignored. The value range gets a little headroom,
     * and a flat series still gets a visible band.
     */
    fun model(raw: List<ChartPoint>, include: List<Double> = emptyList(), max: Int = MAX_POINTS): ChartModel {
        val points = downsample(clean(raw), max)
        if (points.isEmpty()) return ChartModel(emptyList(), 0.0, 1.0, 0L, 0L)
        var lo = points[0].v
        var hi = points[0].v
        for (p in points) {
            if (p.v < lo) lo = p.v
            if (p.v > hi) hi = p.v
        }
        for (level in include) {
            if (!level.isFinite() || level <= 0.0) continue
            if (level < lo) lo = level
            if (level > hi) hi = level
        }
        val span = hi - lo
        val pad = if (span > 0.0) span * 0.08 else hi * 0.005
        return ChartModel(points, lo - pad, hi + pad, points.first().t, points.last().t)
    }

    /** Index of the point nearest to a 0..1 position across the chart. */
    fun nearest(model: ChartModel, fraction: Float): Int {
        val n = model.points.size
        if (n == 0) return -1
        if (n == 1) return 0
        val f = fraction.coerceIn(0f, 1f)
        var best = 0
        var bestGap = Float.MAX_VALUE
        // Binary search on x would save little: n is at most MAX_POINTS.
        for (i in 0 until n) {
            val gap = kotlin.math.abs(model.x(i) - f)
            if (gap < bestGap) { bestGap = gap; best = i }
        }
        return best
    }

    /** "45s", "12m", "3h 20m", "2d 4h". */
    fun spanLabel(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "${s}s"
            s < 3_600 -> "${s / 60}m"
            s < 86_400 -> (s / 3_600).let { h -> val m = (s % 3_600) / 60; if (m == 0L) "${h}h" else "${h}h ${m}m" }
            else -> (s / 86_400).let { d -> val h = (s % 86_400) / 3_600; if (h == 0L) "${d}d" else "${d}d ${h}h" }
        }
    }

    /** "+4.2%" from `from` to `to`. "—" when `from` is not usable. */
    fun pctLabel(from: Double, to: Double): String {
        if (!from.isFinite() || !to.isFinite() || from <= 0.0) return "—"
        val pct = (to / from - 1.0) * 100.0
        val sign = if (pct > 0.0005) "+" else if (pct < -0.0005) "−" else ""
        val abs = kotlin.math.abs(pct)
        return sign + (if (abs >= 100) "%.0f" else if (abs >= 10) "%.1f" else "%.2f").format(Locale.US, abs) + "%"
    }
}
