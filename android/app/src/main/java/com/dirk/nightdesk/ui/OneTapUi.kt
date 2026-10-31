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
    val onSlip: (Double) -> Unit
) {
    fun buying(mint: String) = tapping.contains("buy:$mint")
    fun selling(mint: String) = tapping.contains("sell:$mint")
    val sellingAll get() = tapping.contains("sell-all")
    val buyLabel: String get() = "⚡ Buy " + if (tapUsd >= 100) "$" + "%.0f".format(Locale.US, tapUsd) else "$" + "%.2f".format(Locale.US, tapUsd)
}

/** One-tap size and max slippage, right by the Buy buttons, plus Sell all. Slider + number box each. */
@Composable
fun OneTapBar(ui: OneTapUi, modifier: Modifier = Modifier, showSellAll: Boolean = true) {
    var sizeText by remember(ui.tapUsd) { mutableStateOf(fmt(ui.tapUsd)) }
    var slip by remember(ui.slipPct) { mutableStateOf(ui.slipPct.toFloat()) }
    var slipText by remember(ui.slipPct) { mutableStateOf(fmt(ui.slipPct)) }
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
        if (kotlin.math.abs(c - ui.slipPct) > 1e-9) ui.onSlip(c)
    }
    val maxSize = kotlin.math.max(10.0, kotlin.math.max(ui.maxUsd, kotlin.math.max(ui.capUsd, ui.tapUsd))).toFloat()
    Column(
        modifier
            .fillMaxWidth()
            .background(P.card, RoundedCornerShape(18.dp))
            .border(1.dp, P.accent.copy(alpha = 0.35f), RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("ONE TAP", color = P.accent, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.2.sp, modifier = Modifier.weight(1f))
            if (showSellAll && ui.openCount > 0) {
                BigButton(
                    if (ui.sellingAll) "Selling all…" else if (armed) "Tap again · sell ${ui.openCount}" else "Sell all (${ui.openCount})",
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
        Row(verticalAlignment = Alignment.CenterVertically) {
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
            "One tap buys ${fmtUsd(ui.tapUsd)} now (cut to the ${fmtUsd(ui.capUsd)} cap). No dialog, but slippage (${fmt(slip.toDouble())}%), pool depth, crash guard, hard kills and the −${"%.0f".format(Locale.US, ui.stopPct * 100)}% stop still apply. A stop cannot prevent a gap.",
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
