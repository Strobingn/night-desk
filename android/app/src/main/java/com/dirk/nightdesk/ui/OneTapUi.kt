package com.dirk.nightdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

/**
 * v13.3 one-tap trading state and callbacks handed to the Book, Tape and Add coin screens.
 * The callbacks already include the haptic tick and the in-flight guard.
 */
class OneTapUi(
    val tapUsd: Double,
    val capUsd: Double,
    val maxUsd: Double,
    val slipPct: Double,
    val stopPct: Double,
    val tapping: Set<String>,
    val openCount: Int,
    val onBuy: (mint: String, symbol: String) -> Unit,
    val onSell: (mint: String, symbol: String) -> Unit,
    val onSellAll: () -> Unit,
    val onTapUsd: (Double) -> Unit,
    val onSlip: (Double) -> Unit,
    /** v13.5 the desk is LIVE: buttons say so, the size is the live per-trade size. */
    val live: Boolean = false,
    val liveTrailPct: Double = 0.01,
    /** v13.6 the sentence naming which cap limits the size. */
    val capLine: String? = null,
    /** Armed desk with a separate live book. AI auto-buys stay on paper. */
    val split: Boolean = false,
    val aiLive: Boolean = false,
    val onSellLive: (mint: String, symbol: String) -> Unit = { _, _ -> },
    /** v13.9 LIVE BUY on paper cards: the live size, why it is blocked (null = armed), live holdings, the action. */
    val liveTapUsd: Double = 5.0,
    val liveBlock: String? = null,
    val liveHeld: Map<String, com.dirk.nightdesk.PositionRow> = emptyMap(),
    /** Paper positions by mint → paper PnL $ (for the Tape's PAPER chip). */
    val paperHeld: Map<String, Double> = emptyMap(),
    val onLiveBuy: (mint: String, symbol: String) -> Unit = { _, _ -> }
) {
    fun buyingLive(mint: String) = tapping.contains("livebuy:$mint")
    val liveBuyLabel: String get() = com.dirk.nightdesk.LiveTap.buyLabel(liveTapUsd)
    fun buying(mint: String) = tapping.contains("buy:$mint")
    fun selling(mint: String) = tapping.contains("sell:$mint")
    fun sellingLive(mint: String) = tapping.contains("sell:live:$mint")
    /** v13.7 one-tap sell label for a paper-book position on an armed desk (paper, not live). */
    val paperSellLabel: String get() = "⚡ Sell now"
    val sellingAll get() = tapping.contains("sell-all")
    val buyLabel: String get() = "⚡ Buy " + (if (tapUsd >= 100) "$" + "%.0f".format(Locale.US, tapUsd) else "$" + "%.2f".format(Locale.US, tapUsd)) + (if (live && !split) " LIVE" else "")
    val sellLabel: String get() = if (live) "⚡ Sell now LIVE" else "⚡ Sell now"
}

/** One-tap size and max slippage, right by the Buy buttons, plus Sell all. Slider + number box each. */
@Composable
fun OneTapBar(
    ui: OneTapUi,
    modifier: Modifier = Modifier,
    showSellAll: Boolean = true,
    slipPct: Double = ui.slipPct,
    onSlip: (Double) -> Unit = ui.onSlip,
) {
    var sizeText by remember(ui.tapUsd) { mutableStateOf(fmt(ui.tapUsd)) }
    var slip by remember(slipPct) { mutableStateOf(slipPct.toFloat()) }
    var slipText by remember(slipPct) { mutableStateOf(fmt(slipPct)) }
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) {
        if (armed) {
            kotlinx.coroutines.delay(3_000)
            armed = false
        }
    }
    fun commitSlip(v: Double) {
        if (!v.isFinite()) return
        val c = (kotlin.math.round(v * 2.0) / 2.0).coerceIn(0.5, 50.0)
        slip = c.toFloat()
        slipText = fmt(c)
        if (kotlin.math.abs(c - slipPct) > 1e-9) onSlip(c)
    }
    val maxSize = kotlin.math.max(10.0, kotlin.math.max(ui.maxUsd, kotlin.math.max(ui.capUsd, ui.tapUsd))).toFloat()
    val realTap = ui.live && !ui.split
    Column(
        modifier
            .fillMaxWidth()
            .background(P.card, RoundedCornerShape(18.dp))
            .border(if (realTap) 2.dp else 1.dp, if (realTap) P.down else P.accent.copy(alpha = 0.35f), RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (realTap) {
                Text(
                    "LIVE",
                    color = P.onDown,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 1.2.sp,
                    modifier = Modifier.background(P.down, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp)
                )
                Text(" ", fontSize = 11.sp)
            }
            Text(if (realTap) "ONE TAP · REAL $" else "ONE TAP", color = if (realTap) P.down else P.accent, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.2.sp, modifier = Modifier.weight(1f))
            if (showSellAll && ui.openCount > 0) {
                BigButton(
                    if (ui.sellingAll) "Selling all…" else if (armed) "Tap again · sell ${ui.openCount}" + (if (ui.split) " paper" else "") else "Sell all" + (if (ui.split) " paper" else "") + " (${ui.openCount})",
                    if (armed) P.down else P.down.copy(alpha = 0.85f),
                    P.onDown,
                    Modifier.width(if (armed) 170.dp else 130.dp),
                    height = 38.dp,
                    enabled = !ui.sellingAll
                ) {
                    if (!armed) armed = true else {
                        armed = false
                        ui.onSellAll()
                    }
                }
            }
        }
        if (ui.live) {
            Text(
                "Live size ${fmtUsd(ui.tapUsd)} per trade · trail ${fmt(ui.liveTrailPct * 100)}% · stop −${"%.0f".format(Locale.US, ui.stopPct * 100)}%. Change it in Settings → Live wallet." +
                    (if (ui.split && !ui.aiLive) " AI: paper." else ""),
                color = P.ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold
            )
        } else Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Size $", color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(62.dp))
            Slider(
                value = ui.tapUsd.toFloat().coerceIn(1f, maxSize),
                onValueChange = { ui.onTapUsd(kotlin.math.round(it.toDouble())) },
                valueRange = 1f..maxSize,
                modifier = Modifier.weight(1f),
                colors = sliderColors()
            )
            OutlinedTextField(
                value = sizeText,
                onValueChange = { raw ->
                    sizeText = raw.filter { it.isDigit() || it == '.' }
                    sizeText.toDoubleOrNull()?.takeIf { it > 0 && it.isFinite() }?.let { ui.onTapUsd(it) }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.width(88.dp).padding(start = 6.dp),
                textStyle = androidx.compose.ui.text.TextStyle(color = P.ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Slip %", color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(62.dp))
            Slider(
                value = slip.coerceIn(0.5f, 50f),
                onValueChange = {
                    slip = (kotlin.math.round(it * 2f) / 2f)
                    slipText = fmt(slip.toDouble())
                },
                onValueChangeFinished = { commitSlip(slip.toDouble()) },
                valueRange = 0.5f..50f,
                modifier = Modifier.weight(1f),
                colors = sliderColors()
            )
            OutlinedTextField(
                value = slipText,
                onValueChange = { raw -> slipText = raw.filter { it.isDigit() || it == '.' } },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { slipText.toDoubleOrNull()?.let { commitSlip(it) } }),
                modifier = Modifier.width(88.dp).padding(start = 6.dp),
                textStyle = androidx.compose.ui.text.TextStyle(color = P.ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            )
        }
        Text(
            (if (ui.live && !ui.split) "LIVE: one tap is a real buy of ${fmtUsd(ui.tapUsd)} USDC." else "One tap buys ${fmtUsd(ui.tapUsd)} now (" + com.dirk.nightdesk.OneTap.capHint(ui.capLine, ui.capUsd, ui.tapUsd) + ").") + " No dialog, but slippage (${fmt(slip.toDouble())}%), pool depth, crash guard, hard kills and the −${"%.0f".format(Locale.US, ui.stopPct * 100)}% stop still apply. A stop cannot prevent a gap.",
            color = P.dim,
            fontSize = 11.5.sp,
            lineHeight = 15.sp
        )
    }
}

@Composable
private fun sliderColors() = SliderDefaults.colors(
    thumbColor = P.accent,
    activeTrackColor = P.accent,
    inactiveTrackColor = P.card3,
    activeTickColor = Color.Transparent,
    inactiveTickColor = Color.Transparent
)

private fun fmt(n: Double): String = if (n == kotlin.math.floor(n)) "%.0f".format(Locale.US, n) else "%.1f".format(Locale.US, n)
private fun fmtUsd(n: Double): String = "$" + "%.2f".format(Locale.US, n)

internal val LivePink = Color(0xFFFF2E7E)
private val LiveGreen = Color(0xFF00E676)
private val LiveGreenInk = Color(0xFF00210C)

/** v13.9 PAPER / LIVE tag. */
@Composable
fun BookTag(live: Boolean) {
    Text(
        if (live) "LIVE" else "PAPER",
        color = if (live) Color.White else Color(0xFF9CC3FF),
        fontSize = 10.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 1.2.sp,
        modifier = Modifier.background(if (live) LivePink else Color(0xFF2B3A55), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

/**
 * v13.9 LIVE BUY / LIVE SELL right beside each other on a paper card (Book and Tape).
 * The paper numbers stay on the card; this strip is the real-money side only.
 * LIVE BUY: the live size into the LIVE book (never paper). LIVE SELL: 100% of the live position, no confirm.
 */
@Composable
fun LivePair(ui: OneTapUi, mint: String, symbol: String, modifier: Modifier = Modifier, compact: Boolean = false) {
    val held = ui.liveHeld[mint]
    val buying = ui.buyingLive(mint)
    val selling = ui.sellingLive(mint)
    Column(
        modifier
            .fillMaxWidth()
            .background(LivePink.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
            .border(1.5.dp, LivePink, RoundedCornerShape(14.dp))
            .padding(if (compact) 6.dp else 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BookTag(live = true)
            Text(" ", fontSize = 11.sp)
            if (held != null) {
                val tint = if (held.pnlUsd >= 0) P.up else P.down
                Text(
                    "cost ${com.dirk.nightdesk.formatUsd(held.costUsd)} · value ${com.dirk.nightdesk.formatUsd(held.marketValueUsd)} · " +
                        (if (held.pnlUsd >= 0) "+" else "−") + com.dirk.nightdesk.formatUsd(kotlin.math.abs(held.pnlUsd)) +
                        " (" + (if (held.pnlPct >= 0) "+" else "−") + "%.1f".format(Locale.US, kotlin.math.abs(held.pnlPct) * 100) + "%)",
                    color = tint,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1
                )
            } else {
                Text(
                    ui.liveBlock?.removeSuffix(" Nothing was sent.") ?: "No live position in this coin",
                    color = P.muted,
                    fontSize = 12.sp,
                    maxLines = 1
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BigButton(
                if (buying) "Buying…" else ui.liveBuyLabel,
                if (ui.liveBlock == null) LiveGreen else LiveGreen.copy(alpha = 0.55f),
                LiveGreenInk,
                Modifier.weight(1f),
                height = if (compact) 38.dp else 46.dp,
                enabled = !buying
            ) { ui.onLiveBuy(mint, symbol) }
            BigButton(
                if (selling) "Selling…" else "LIVE SELL",
                if (held != null) Color(0xFFFF3D57) else P.card3,
                if (held != null) Color.White else P.muted,
                Modifier.weight(1f),
                height = if (compact) 38.dp else 46.dp,
                enabled = held != null && !selling
            ) { ui.onSellLive(mint, symbol) }
        }
    }
}
