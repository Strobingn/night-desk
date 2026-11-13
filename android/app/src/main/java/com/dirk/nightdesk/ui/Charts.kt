package com.dirk.nightdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ChartMath
import com.dirk.nightdesk.ChartModel
import com.dirk.nightdesk.ChartPoint
import com.dirk.nightdesk.ChartRange
import com.dirk.nightdesk.EquityPoint
import com.dirk.nightdesk.PositionRow
import com.dirk.nightdesk.PriceText
import com.dirk.nightdesk.formatUsd
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A horizontal level on a chart: the entry, the stop, the starting balance. */
data class ChartLevel(val value: Double, val color: Color, val label: String? = null)

/**
 * The one line chart every screen uses. x follows time. The path and fill are built once per
 * data or size change (drawWithCache), not on every frame. With `scrub`, a held or dragged
 * finger reports the nearest point through `onScrub`; lifting reports -1.
 */
@Composable
fun LineChart(
    model: ChartModel,
    color: Color,
    modifier: Modifier = Modifier,
    height: Dp = 48.dp,
    levels: List<ChartLevel> = emptyList(),
    scrub: Boolean = false,
    onScrub: (Int) -> Unit = {}
) {
    // The finger's place is kept as a share of the width, not as a point index, and the gesture is
    // not keyed on the model: a new sample every few seconds must not cancel a held finger.
    var scrubX by remember(scrub) { mutableFloatStateOf(-1f) }
    val scrubAt = if (scrubX >= 0f && model.points.size >= 2) ChartMath.nearest(model, scrubX) else -1
    val report by rememberUpdatedState(onScrub)
    LaunchedEffect(scrubAt) { report(scrubAt) }
    val measurer = rememberTextMeasurer()
    val labelStyle = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
    val ink = P.ink
    val card = P.card
    val gesture = if (!scrub) Modifier else Modifier.pointerInput(Unit) {
        fun at(x: Float) {
            scrubX = if (size.width > 0) (x / size.width).coerceIn(0f, 1f) else 0f
        }
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            at(down.position.x)
            // A sideways drag scrubs. A vertical one is left to the list, and the readout clears.
            val drag = awaitHorizontalTouchSlopOrCancellation(down.id) { change, _ ->
                change.consume()
                at(change.position.x)
            }
            if (drag != null) {
                horizontalDrag(drag.id) { change ->
                    change.consume()
                    at(change.position.x)
                }
            }
            scrubX = -1f
        }
    }
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .then(gesture)
            .drawWithCache {
                val pad = 3.dp.toPx()
                val w = size.width
                val h = size.height - 2 * pad
                fun px(i: Int) = model.x(i) * w
                fun py(v: Double) = pad + (1f - model.y(v)) * h
                val n = model.points.size
                val line = Path()
                val area = Path()
                if (n >= 2) {
                    for (i in 0 until n) {
                        val x = px(i)
                        val y = py(model.points[i].v)
                        if (i == 0) line.moveTo(x, y) else line.lineTo(x, y)
                    }
                    area.addPath(line)
                    area.lineTo(px(n - 1), size.height)
                    area.lineTo(px(0), size.height)
                    area.close()
                }
                val fill = Brush.verticalGradient(listOf(color.copy(alpha = 0.26f), color.copy(alpha = 0f)), startY = 0f, endY = size.height)
                val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))
                val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                val labels = levels.map { level -> level.label?.let { measurer.measure(it, labelStyle.copy(color = level.color)) } }
                onDrawBehind {
                    levels.forEachIndexed { i, level ->
                        if (!level.value.isFinite() || level.value <= 0.0) return@forEachIndexed
                        val y = py(level.value)
                        drawLine(level.color.copy(alpha = 0.7f), Offset(0f, y), Offset(w, y), strokeWidth = 1.dp.toPx(), pathEffect = dash)
                        val text = labels[i] ?: return@forEachIndexed
                        // Above the line when there is room, else below it.
                        val ty = if (y - text.size.height - 1.dp.toPx() >= 0f) y - text.size.height - 1.dp.toPx() else y + 1.dp.toPx()
                        drawText(text, topLeft = Offset(w - text.size.width - 2.dp.toPx(), ty))
                    }
                    if (n >= 2) {
                        drawPath(area, fill)
                        drawPath(line, color, style = stroke)
                    }
                    if (n >= 1) {
                        val at = if (scrubAt in 0 until n) scrubAt else n - 1
                        val cx = px(at).coerceIn(4.dp.toPx(), w - 4.dp.toPx())
                        val cy = py(model.points[at].v)
                        if (scrubAt in 0 until n) drawLine(ink.copy(alpha = 0.35f), Offset(cx, 0f), Offset(cx, size.height), strokeWidth = 1.dp.toPx())
                        drawCircle(card, radius = 5.dp.toPx(), center = Offset(cx, cy))
                        drawCircle(color, radius = 3.5.dp.toPx(), center = Offset(cx, cy))
                    }
                }
            }
    )
}

/**
 * The price chart on a position card. Collapsed: the line since the buy against the entry.
 * Expanded: taller, with the entry and stop levels labelled and a readout that follows the finger.
 */
@Composable
fun CoinChart(pos: PositionRow, expanded: Boolean) {
    val model = remember(pos.marks, pos.entryPrice, pos.stopPrice, pos.openedAt, expanded) {
        var points = pos.marks.map { ChartPoint(it.t, it.priceUsd) }
        // One mark is a dot, not a line: start the line at the fill.
        if (points.size == 1 && pos.entryPrice > 0 && pos.openedAt in 1 until points[0].t) {
            points = listOf(ChartPoint(pos.openedAt, pos.entryPrice)) + points
        }
        ChartMath.model(points, include = if (expanded) listOf(pos.entryPrice, pos.stopPrice) else listOf(pos.entryPrice))
    }
    if (model.empty) return
    val up = model.last >= pos.entryPrice
    val color = if (up) P.up else P.down
    var scrubAt by remember { mutableIntStateOf(-1) }
    val levels = if (expanded) {
        listOf(ChartLevel(pos.entryPrice, P.muted, "entry"), ChartLevel(pos.stopPrice, P.down, "stop"))
    } else {
        listOf(ChartLevel(pos.entryPrice, P.faint))
    }
    Column(Modifier.fillMaxWidth().padding(top = 4.dp).testTag("chart-${pos.symbol}")) {
        if (expanded) {
            val point = model.points.getOrNull(scrubAt)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (point != null) PriceText.px(point.v) + "  " + ChartMath.pctLabel(pos.entryPrice, point.v)
                    else "Since buy  " + ChartMath.pctLabel(pos.entryPrice, model.last),
                    color = if (point != null) pnlTint(point.v - pos.entryPrice) else color,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    if (point != null) ChartMath.spanLabel(model.t1 - point.t) + " ago"
                    else ChartMath.spanLabel(model.spanMs) + " · hold to read",
                    color = P.muted,
                    fontSize = 11.sp,
                    maxLines = 1
                )
            }
        }
        LineChart(model, color, height = if (expanded) 132.dp else 44.dp, levels = levels, scrub = expanded, onScrub = { scrubAt = it })
        if (expanded) {
            Row(Modifier.fillMaxWidth().padding(top = 2.dp)) {
                Text("low ${PriceText.px(model.points.minOf { it.v })}", color = P.muted, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1)
                Text("high ${PriceText.px(model.points.maxOf { it.v })}", color = P.muted, fontSize = 11.sp, maxLines = 1)
            }
        }
    }
}

private val SCRUB_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.US)

private fun chartSignedUsd(n: Double): String = (if (n > 0.004) "+" else if (n < -0.004) "−" else "") + formatUsd(kotlin.math.abs(n))

/**
 * The equity curve on Home with 1H / 6H / 1D / All. The header reads the change over the chosen
 * window, or the equity and time under the finger while scrubbing. A window is only offered when
 * the desk has sent enough points inside it.
 */
@Composable
fun PerformanceChart(points: List<EquityPoint>, startBalance: Double, modifier: Modifier = Modifier, tag: String = "performance-chart") {
    var picked by rememberSaveable { mutableStateOf(ChartRange.ALL) }
    val all = remember(points) { ChartMath.clean(points.map { ChartPoint(it.t, it.equity) }) }
    val offered = remember(all) { ChartRange.entries.filter { ChartMath.usable(all, it) } }
    val range = if (picked in offered) picked else ChartRange.ALL
    val model = remember(all, range, startBalance) {
        ChartMath.model(ChartMath.window(all, range), include = if (range == ChartRange.ALL) listOf(startBalance) else emptyList())
    }
    // All: measured against the starting balance. A window: against its own first point.
    val from = if (range == ChartRange.ALL || model.empty) startBalance else model.first
    val change = (if (model.empty) startBalance else model.last) - from
    val color = if (change >= 0) P.up else P.down
    var scrubAt by remember { mutableIntStateOf(-1) }
    val point = model.points.getOrNull(scrubAt)
    Column(modifier.fillMaxWidth().testTag(tag)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (point != null) formatUsd(point.v) else chartSignedUsd(change) + "  " + ChartMath.pctLabel(from, from + change),
                    color = if (point != null) P.ink else color,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    if (point != null) SCRUB_TIME.format(Instant.ofEpochMilli(point.t).atZone(ZoneId.systemDefault()))
                    else if (range == ChartRange.ALL) "since the book started" + (if (model.spanMs > 0) " · " + ChartMath.spanLabel(model.spanMs) else "")
                    else "last ${range.label.lowercase(Locale.US)}",
                    color = P.muted,
                    fontSize = 11.sp,
                    maxLines = 1
                )
            }
            if (offered.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (option in offered) {
                        val on = option == range
                        Text(
                            option.label,
                            color = if (on) P.onAccent else P.muted,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .clip(RoundedCornerShape(50))
                                .background(if (on) P.accent else P.card3)
                                .clickable { picked = option }
                                .padding(horizontal = 9.dp, vertical = 5.dp)
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        if (model.points.size >= 2) {
            LineChart(
                model,
                color,
                height = 96.dp,
                levels = if (range == ChartRange.ALL) listOf(ChartLevel(startBalance, P.faint, "start")) else emptyList(),
                scrub = true,
                onScrub = { scrubAt = it }
            )
        } else {
            Box(Modifier.fillMaxWidth().height(40.dp), contentAlignment = Alignment.CenterStart) {
                Text("The curve appears once the desk has marked the book a few times.", color = P.muted, fontSize = 12.sp)
            }
        }
    }
}
