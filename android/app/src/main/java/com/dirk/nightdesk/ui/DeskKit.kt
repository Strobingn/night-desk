package com.dirk.nightdesk.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.Verdict
import java.util.Locale

/* ---------- Icons: same stroke paths as web/src/ui.tsx ---------- */

private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r},$cy a$r,$r 0 1,0 ${2 * r},0 a$r,$r 0 1,0 ${-2 * r},0"

private val ICON_PATHS: Map<String, List<String>> = mapOf(
    "home" to listOf("M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"),
    "tape" to listOf("M3 12h4l3-8 4 16 3-8h4"),
    "add" to listOf(circle(12f, 12f, 9f), "M12 8v8M8 12h8"),
    "search" to listOf(circle(10.5f, 10.5f, 6.5f), "M15.5 15.5 21 21"),
    "recap" to listOf("M5 20V10M12 20V4M19 20v-7"),
    "settings" to listOf("M4 7h10M18 7h2M4 17h4M12 17h8", circle(16f, 7f, 2f), circle(10f, 17f, 2f)),
    "link" to listOf("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
    "moon" to listOf("M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"),
    "sun" to listOf(circle(12f, 12f, 4f), "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"),
    "auto" to listOf(circle(12f, 12f, 9f), "M12 3v18"),
    "coins" to listOf(circle(9f, 9f, 6f), "M15.5 9.2A6 6 0 1 1 9.2 15.5"),
    "list" to listOf("M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"),
    "shield" to listOf("M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"),
    "filter" to listOf("M4 5h16l-6 8v6l-4-2v-4z"),
    "exit" to listOf("M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l-4-4 4-4M6 12h10"),
    "radar" to listOf(circle(12f, 12f, 9f), circle(12f, 12f, 4f), "M12 12 18 6"),
    "bell" to listOf("M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4"),
    "palette" to listOf("M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1-.8-1.4-.8-2.3 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.7-9-8.7z", "M7.5 11h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01")
)

private val iconCache = HashMap<String, ImageVector>()

fun deskIcon(name: String): ImageVector = iconCache.getOrPut(name) {
    val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    ICON_PATHS[name].orEmpty().forEach { d ->
        b.addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round
        )
    }
    b.build()
}

@Composable
fun DeskIcon(name: String, tint: Color = P.ink, size: Dp = 22.dp) {
    Icon(deskIcon(name), contentDescription = null, tint = tint, modifier = Modifier.size(size))
}

/* ---------- Surfaces ---------- */

fun Modifier.deskCard(radius: Dp = 20.dp, color: Color? = null): Modifier =
    this.fillMaxWidth()
        .clip(RoundedCornerShape(radius))
        .background(color ?: P.card)
        .border(1.dp, P.line, RoundedCornerShape(radius))

@Composable
fun SectionTitle(title: String, trailing: String? = null, trailingColor: Color = P.muted) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, color = trailingColor, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun GroupHeader(icon: String, title: String, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(14.dp)).background(P.accent.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center
        ) { DeskIcon(icon, tint = P.accent, size = 20.dp) }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(text, color = P.muted, fontSize = 12.5.sp, lineHeight = 17.sp)
        }
    }
}

/* ---------- Chips ---------- */

@Composable
fun Chip(text: String, fg: Color, bg: Color, bold: Boolean = true, size: Int = 12) {
    Text(
        text,
        color = fg,
        fontSize = size.sp,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
        maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 9.dp, vertical = 3.dp)
    )
}

@Composable
fun PnlChip(usd: Double, pct: Double?) {
    val c = when { usd > 0 -> P.up; usd < 0 -> P.down; else -> P.ink }
    Chip(signedUsd(usd) + (if (pct != null) "  ·  " + signedPct(pct) else ""), c, c.copy(alpha = if (usd == 0.0) 0.08f else 0.16f), size = 13)
}

fun verdictColor(v: Verdict): Color = when (v) {
    Verdict.TRADE -> P.up
    Verdict.NEAR -> P.amber
    Verdict.KILLED -> P.down
    Verdict.OPEN, Verdict.BOUGHT -> P.blue
    Verdict.SEEN -> P.muted
}

@Composable
fun VerdictChip(v: Verdict) {
    val c = verdictColor(v)
    Chip(v.label, c, c.copy(alpha = 0.18f), size = 11)
}

@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, icons: Map<String, String> = emptyMap(), modifier: Modifier = Modifier, compact: Boolean = false, onSelect: (String) -> Unit) {
    Row(
        modifier.clip(RoundedCornerShape(50)).background(P.card).border(1.dp, P.line, RoundedCornerShape(50)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        options.forEach { (id, label) ->
            val on = id == selected
            Row(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(if (on) P.accent else Color.Transparent)
                    .clickable { onSelect(id) }
                    .padding(horizontal = if (compact) 10.dp else 14.dp, vertical = if (compact) 6.dp else 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                icons[id]?.let {
                    DeskIcon(it, tint = if (on) P.onAccent else P.dim, size = if (compact) 14.dp else 16.dp)
                    Spacer(Modifier.width(if (compact) 4.dp else 6.dp))
                }
                Text(label, color = if (on) P.onAccent else P.dim, fontSize = if (compact) 12.5.sp else 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Equal-width segmented control (Appearance). */
@Composable
fun SegmentedFill(options: List<Pair<String, String>>, selected: String, icons: Map<String, String>, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(P.surface).border(1.dp, P.line, RoundedCornerShape(50)).padding(3.dp)
    ) {
        options.forEach { (id, label) ->
            val on = id == selected
            Row(
                Modifier.weight(1f).clip(RoundedCornerShape(50)).background(if (on) P.accent else Color.Transparent).clickable { onSelect(id) }.padding(vertical = 10.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                icons[id]?.let { DeskIcon(it, tint = if (on) P.onAccent else P.dim, size = 16.dp); Spacer(Modifier.width(6.dp)) }
                Text(label, color = if (on) P.onAccent else P.dim, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
fun PillChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (on) P.onAccent else P.dim,
        fontSize = 13.sp,
        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (on) P.accent else P.card)
            .border(1.dp, if (on) P.accent else P.lineStrong, RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp)
    )
}

/* ---------- Avatar ---------- */

@Composable
fun CoinAvatar(symbol: String, mint: String, ring: Color? = null, size: Dp = 44.dp) {
    val letters = symbol.filter { it.isLetterOrDigit() }.take(2).uppercase(Locale.US).ifBlank { "?" }
    var h = 0
    for (ch in mint) h = h * 31 + ch.code
    val bg = P.avatars[Math.floorMod(h, P.avatars.size)]
    Box(
        Modifier
            .size(size)
            .then(if (ring != null) Modifier.border(2.dp, ring, CircleShape).padding(3.dp) else Modifier)
            .clip(CircleShape)
            .background(bg),
        contentAlignment = Alignment.Center
    ) {
        Text(letters, color = P.ink, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.32f).sp)
    }
}

/* ---------- Sparkline ---------- */

@Composable
fun Sparkline(values: List<Double>, baseline: Double, modifier: Modifier = Modifier) {
    val series = if (values.size > 1) values else listOf(baseline, values.firstOrNull() ?: baseline)
    val up = series.last() >= baseline
    val line = if (up) P.up else P.down
    val base = P.ink.copy(alpha = 0.25f)
    Canvas(modifier.fillMaxWidth().height(56.dp)) {
        val min = minOf(series.min(), baseline)
        val max = maxOf(series.max(), baseline)
        val span = (max - min).takeIf { it > 0 } ?: 1.0
        val pad = 4f
        fun y(v: Double) = (size.height - pad - ((v - min) / span) * (size.height - 2 * pad)).toFloat()
        val step = size.width / (series.size - 1)
        val path = Path()
        series.forEachIndexed { i, v -> if (i == 0) path.moveTo(0f, y(v)) else path.lineTo(i * step, y(v)) }
        val area = Path().apply { addPath(path); lineTo(size.width, size.height); lineTo(0f, size.height); close() }
        drawLine(base, Offset(0f, y(baseline)), Offset(size.width, y(baseline)), strokeWidth = 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 10f)))
        drawPath(area, Brush.verticalGradient(listOf(line.copy(alpha = 0.28f), line.copy(alpha = 0f))))
        drawPath(path, line.copy(alpha = 0.35f), style = Stroke(width = 9f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        drawPath(path, line, style = Stroke(width = 5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/* ---------- Stop → trail bar ---------- */

data class StopBarModel(val fill: Float, val entryAt: Float, val nearStop: Boolean, val stopPct: Double?, val right: String, val stopFromEntry: Double? = null) {
    /** v13.8 "Stop −3.0% · 1.8% away": the stop level from entry, then how far the mark is above it. */
    val label: String get() {
        val level = stopFromEntry?.let { signedPct1(it) } ?: "—"
        val away = stopPct?.let { if (it < 0) "%.1f%% away".format(java.util.Locale.US, -it * 100) else "at the stop" }
        return "Stop $level" + (away?.let { " · $it" } ?: "")
    }
}

private fun signedPct1(n: Double): String {
    if (!n.isFinite()) return "—"
    val sign = if (n > 0) "+" else if (n < 0) "−" else ""
    return sign + "%.1f".format(java.util.Locale.US, kotlin.math.abs(n) * 100) + "%"
}

fun stopBarModel(stop: Double, entry: Double, mark: Double, peak: Double, armPct: Double, trailOn: Boolean): StopBarModel {
    val arm = entry * (1 + armPct)
    val hi = maxOf(arm, peak)
    val span = hi - stop
    fun at(p: Double): Float = if (span > 0) (((p - stop) / span).coerceIn(0.0, 1.0)).toFloat() else 0.5f
    val fill = at(mark)
    val toStop = if (mark > 0) stop / mark - 1 else null
    val armTxt = "+${Math.round(armPct * 100)}%"
    val right = if (trailOn) (if (peak >= arm && peak > 0) "Trailing" else "Trail arms $armTxt") else "Trail off · $armTxt"
    val fromEntry = if (entry > 0 && stop > 0) stop / entry - 1 else null
    return StopBarModel(fill, at(entry), fill < 0.25f, toStop, right, fromEntry)
}

@Composable
fun StopTrailBar(model: StopBarModel) {
    val track = P.card3
    val down = P.down
    val amber = P.amber
    val up = P.up
    val ink = P.ink
    val card = P.card
    val muted = P.dim
    Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        Canvas(Modifier.fillMaxWidth().height(14.dp)) {
            val h = 8.dp.toPx()
            val top = (size.height - h) / 2
            drawRoundRect(track, Offset(0f, top), Size(size.width, h), CornerRadius(h / 2))
            val w = size.width * model.fill
            if (w > 0f) {
                val brush = if (model.nearStop) SolidColor(down) else Brush.horizontalGradient(listOf(down, amber, up), startX = 0f, endX = size.width)
                drawRoundRect(brush, Offset(0f, top), Size(w, h), CornerRadius(h / 2))
            }
            val ex = size.width * model.entryAt
            drawLine(muted, Offset(ex, 0f), Offset(ex, size.height), strokeWidth = 2.dp.toPx())
            drawCircle(card, radius = 7.dp.toPx(), center = Offset(w.coerceIn(7.dp.toPx(), size.width - 7.dp.toPx()), size.height / 2))
            drawCircle(ink, radius = 5.dp.toPx(), center = Offset(w.coerceIn(7.dp.toPx(), size.width - 7.dp.toPx()), size.height / 2))
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(model.label, color = P.down, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1)
            Text("entry", color = P.muted, fontSize = 11.sp)
            Text(model.right, color = P.muted, fontSize = 11.sp, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
        }
    }
}

/* ---------- Buttons ---------- */

@Composable
fun BigButton(label: String, bg: Color, fg: Color, modifier: Modifier = Modifier, border: Color? = null, height: Dp = 52.dp, enabled: Boolean = true, onClick: () -> Unit) {
    // Visual size can be compact. The clickable area stays at least 48dp.
    val touch = if (height < 48.dp) 48.dp else height
    Box(
        modifier.height(touch).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(height)
                .clip(RoundedCornerShape(12.dp))
                .background(if (enabled) bg else bg.copy(alpha = 0.4f))
                .then(if (border != null) Modifier.border(BorderStroke(1.dp, border), RoundedCornerShape(12.dp)) else Modifier)
        )
        Text(label, color = fg, fontSize = if (height < 40.dp) 13.sp else 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
    }
}

@Composable
fun RowScope.HeroStat(label: String, value: String, hint: String, hintColor: Color = P.muted) {
    Column(Modifier.weight(1f)) {
        Text(label, color = P.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(hint, color = hintColor, fontSize = 11.5.sp, maxLines = 1)
    }
}

/* ---------- Formatting ---------- */

fun signedUsd(n: Double): String {
    val sign = when { n > 0 -> "+"; n < 0 -> "−"; else -> "" }
    return sign + "$" + "%,.2f".format(Locale.US, kotlin.math.abs(n))
}

fun signedPct(fraction: Double): String {
    if (!fraction.isFinite()) return "—"
    val sign = when { fraction > 0 -> "+"; fraction < 0 -> "−"; else -> "" }
    return sign + "%.2f".format(Locale.US, kotlin.math.abs(fraction * 100)) + "%"
}

/* ---------- v13.32 list rows and sections: one shape for every screen ---------- */

/**
 * A row in a list: optional leading slot, a title, an optional second line, a trailing slot.
 * Every settings row, "More" entry and secondary list uses this so the screens read the same.
 */
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    titleColor: Color = P.ink,
    onClick: (() -> Unit)? = null
) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, color = titleColor, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) Text(subtitle, color = P.muted, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) {
            Spacer(Modifier.width(10.dp))
            trailing()
        }
    }
}

/** Small chevron for rows that open something. */
@Composable
fun Chevron(tint: Color = P.faint) {
    Text("›", color = tint, fontSize = 20.sp, fontWeight = FontWeight.Medium)
}

/** A one-dp line between rows in a section. */
@Composable
fun RowDivider() {
    Box(Modifier.fillMaxWidth().padding(start = 14.dp).height(1.dp).background(P.line))
}

/**
 * A titled card with rows inside. `trailing` sits at the right of the title (a count, a status).
 * With `collapsible`, the title toggles the body; `open` is the starting state.
 */
@Composable
fun Section(
    title: String,
    modifier: Modifier = Modifier,
    trailing: String? = null,
    trailingColor: Color = P.muted,
    collapsible: Boolean = false,
    open: Boolean = true,
    padded: Boolean = false,
    body: @Composable () -> Unit
) {
    var shown by rememberSaveable(title) { mutableStateOf(open) }
    Column(modifier.deskCard(radius = 16.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (collapsible) Modifier.clickable { shown = !shown } else Modifier)
                .padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = if (shown || !collapsible) 6.dp else 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(title, color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.3.sp, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, color = trailingColor, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (collapsible) {
                Spacer(Modifier.width(8.dp))
                Text(if (shown) "▴" else "▾", color = P.faint, fontSize = 12.sp)
            }
        }
        if (shown || !collapsible) {
            if (padded) Column(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { body() }
            else Column(Modifier.padding(bottom = 4.dp)) { body() }
        }
    }
}

/** Label over value, for a row of three or four numbers. */
@Composable
fun RowScope.Stat(label: String, value: String, tint: Color = P.ink, big: Boolean = false) {
    Column(Modifier.weight(1f)) {
        Text(label.uppercase(Locale.US), color = P.faint, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp, maxLines = 1)
        Text(value, color = tint, fontSize = if (big) 18.sp else 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Thin horizontal bar: `fraction` of the width filled, 0..1. */
@Composable
fun ThinBar(fraction: Float, color: Color, modifier: Modifier = Modifier, track: Color = P.card3) {
    val f = fraction.coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(track)) {
        Box(Modifier.fillMaxWidth(f).height(4.dp).background(color))
    }
}

/** A small "Hide ▴ / More ▾" text toggle. */
@Composable
fun Disclosure(open: Boolean, openLabel: String = "Hide", closedLabel: String = "Details", tag: String? = null, onToggle: () -> Unit) {
    Text(
        if (open) "$openLabel ▴" else "$closedLabel ▾",
        color = P.accent,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .clickable(onClick = onToggle)
            .padding(vertical = 6.dp)
    )
}

fun pnlTint(n: Double): Color = if (n > 0) P.up else if (n < 0) P.down else P.muted
