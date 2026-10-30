package com.dirk.nightdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.DeskSnapshot

private data class Draft(
    val volume: Float,
    val score: Float,
    val top10: Float,
    val position: Float,
    val slip: Float,
    val buy: Float,
    val useCap: Boolean,
    val open: Float,
    val unlocked: Boolean,
    val liquidity: Float,
    val minAge: Float,
    val maxAge: Float,
    val holders: Float,
    val dev: Float,
    val rate: Float,
    val dailyLoss: Float,
    val cooldown: Float,
    val stop: Float,
    val arm: Float,
    val gap: Float,
    val trail: Boolean,
    val autoBuy: Boolean,
    val dex: Boolean,
    val gecko: Boolean,
    val jupiter: Boolean,
    val paprika: Boolean,
    val bitquery: Boolean,
    val near: Boolean,
    val fills: Boolean,
    val stops: Boolean,
    val alert: Float
)

private fun draftOf(snap: DeskSnapshot?): Draft {
    val buy = snap?.defaultBuyUsd
    return Draft(
        volume = (snap?.minVolume1hUsd ?: 10_000.0).toFloat(),
        score = (snap?.analystMinScore ?: 0.5).toFloat(),
        top10 = ((snap?.maxTop10Pct ?: 0.35) * 100.0).toFloat(),
        position = ((snap?.maxPositionPct ?: 0.08) * 100.0).toFloat(),
        slip = ((snap?.maxEntrySlippage ?: 0.03) * 100.0).toFloat(),
        buy = (buy ?: snap?.positionCapUsd ?: 8.0).toFloat().coerceAtLeast(1f),
        useCap = buy == null,
        open = (snap?.maxOpenPositions ?: 12).toFloat(),
        unlocked = snap?.allowUnlockedLp != false,
        liquidity = (snap?.minLiquidityUsd ?: 0.0).toFloat(),
        minAge = (snap?.minTokenAgeMin ?: 0.0).toFloat(),
        maxAge = (snap?.maxTokenAgeMin ?: 0.0).toFloat(),
        holders = (snap?.minHolderCount ?: 0.0).toFloat(),
        dev = ((snap?.maxDevHoldingPct ?: 0.0) * 100.0).toFloat(),
        rate = (snap?.maxTradesPerHour ?: 0.0).toFloat(),
        dailyLoss = (snap?.dailyMaxLossUsd ?: 0.0).toFloat(),
        cooldown = (snap?.cooldownHours ?: 6.0).toFloat().coerceAtLeast(6f),
        stop = ((snap?.stopLossPct ?: 0.06) * 100.0).toFloat().coerceIn(1f, 6f),
        arm = ((snap?.trailArmPct ?: 0.12) * 100.0).toFloat().coerceAtLeast(12f),
        gap = ((snap?.trailGapPct ?: 0.04) * 100.0).toFloat().coerceIn(0.5f, 4f),
        trail = snap?.trailTakeProfit == true,
        autoBuy = snap?.autoBuy != false,
        dex = snap?.scoutDexscreener != false,
        gecko = snap?.scoutGecko != false,
        jupiter = snap?.scoutJupiter != false,
        paprika = snap?.scoutDexpaprika == true,
        bitquery = snap?.scoutBitquery != false,
        near = snap?.notifyNearMiss != false,
        fills = snap?.notifyFills != false,
        stops = snap?.notifyStops != false,
        alert = (snap?.pnlAlertPct ?: 0.0).toFloat()
    )
}

@Composable
fun SettingsScreen(snap: DeskSnapshot?, onSave: (Map<String, Any?>) -> Unit) {
    var draft by remember { mutableStateOf(draftOf(snap)) }
    var saved by remember { mutableStateOf(draftOf(snap)) }
    val incoming = draftOf(snap)
    LaunchedEffect(incoming) {
        if (draft == saved) {
            draft = incoming
            saved = incoming
        }
    }
    val dirty = draft != saved
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("SETTINGS", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 1.4.sp)
        Text(if (dirty) "Unsaved changes" else "Matches the desk", color = if (dirty) Amber else Dim, fontSize = 13.sp)
        Group("Entry / Filter") {
            ExactSlider("1h volume $", draft.volume, 1_000f..500_000f, 1000f, { "%.0f".format(it) }) { draft = draft.copy(volume = it) }
            ExactSlider("Trade line", draft.score, 0.10f..0.95f, 0.01f, { "%.2f".format(it) }) { draft = draft.copy(score = it) }
            ExactSlider("Top 10 cap %", draft.top10, 5f..35f, 1f, { "%.0f".format(it) }) { draft = draft.copy(top10 = it) }
            ExactSlider("Min liquidity $", draft.liquidity, 0f..200_000f, 1000f, { "%.0f".format(it) }) { draft = draft.copy(liquidity = it) }
            ExactSlider("Min age min", draft.minAge, 0f..1440f, 5f, { "%.0f".format(it) }) { draft = draft.copy(minAge = it) }
            ExactSlider("Max age min", draft.maxAge, 0f..10080f, 30f, { "%.0f".format(it) }) { draft = draft.copy(maxAge = it) }
            ExactSlider("Min holders", draft.holders, 0f..2000f, 10f, { "%.0f".format(it) }) { draft = draft.copy(holders = it) }
            ExactSlider("Max dev holding %", draft.dev, 0f..50f, 1f, { "%.0f".format(it) }) { draft = draft.copy(dev = it) }
            ToggleRow("Allow unlocked LP", draft.unlocked) { draft = draft.copy(unlocked = it) }
            Text("0 on a floor turns that extra gate off. Mint authority and dev rugs stay hard kills.", color = Dim, fontSize = 12.sp)
        }
        Group("Risk / Exits") {
            ExactSlider("Hard stop %", draft.stop, 1f..6f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(stop = it.coerceAtMost(6f)) }
            Text("Locked at 6% or tighter. The desk refuses a looser stop.", color = Dim, fontSize = 12.sp)
            ExactSlider("Cooldown hours", draft.cooldown, 6f..72f, 1f, { "%.0f".format(it) }) { draft = draft.copy(cooldown = it.coerceAtLeast(6f)) }
            ExactSlider("Daily max loss $", draft.dailyLoss, 0f..1000f, 5f, { "%.0f".format(it) }) { draft = draft.copy(dailyLoss = it) }
            ExactSlider("Trail arm %", draft.arm, 12f..80f, 1f, { "%.0f".format(it) }) { draft = draft.copy(arm = it.coerceAtLeast(12f)) }
            ExactSlider("Trail gap %", draft.gap, 0.5f..4f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(gap = it.coerceAtMost(4f)) }
            ToggleRow("Trailing take profit", draft.trail) { draft = draft.copy(trail = it) }
            Text("Off by default. Winners stay until you sell. Arm cannot be easier than 12%. Gap cannot be wider than 4%.", color = Dim, fontSize = 12.sp)
        }
        Group("Sizing") {
            ExactSlider("Max position %", draft.position, 1f..8f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(position = it) }
            ExactSlider("Entry slippage %", draft.slip, 0.5f..3f, 0.1f, { "%.1f".format(it) }) { draft = draft.copy(slip = it) }
            ExactSlider("Manual buy $", draft.buy, 1f..500f, 1f, { "%.0f".format(it) }) { draft = draft.copy(buy = it, useCap = false) }
            ToggleRow("Use the position cap instead", draft.useCap) { draft = draft.copy(useCap = it) }
            ExactSlider("Max open", draft.open, 1f..24f, 1f, { "%.0f".format(it) }) { draft = draft.copy(open = it) }
            ExactSlider("Max trades / hour", draft.rate, 0f..60f, 1f, { "%.0f".format(it) }) { draft = draft.copy(rate = it) }
            ToggleRow("Auto-buy", draft.autoBuy) { draft = draft.copy(autoBuy = it) }
            Text("0 trades per hour means no hourly cap. Auto-buy off still leaves manual Buy and Buy anyway.", color = Dim, fontSize = 12.sp)
        }
        Group("Scout sources") {
            ToggleRow("Pump", true) {}
            Text("Pump stays on. It is the primary feed.", color = Dim, fontSize = 12.sp)
            ToggleRow("DexScreener", draft.dex) { draft = draft.copy(dex = it) }
            ToggleRow("Gecko", draft.gecko) { draft = draft.copy(gecko = it) }
            ToggleRow("Jupiter", draft.jupiter) { draft = draft.copy(jupiter = it) }
            ToggleRow("DexPaprika / Meteora", draft.paprika) { draft = draft.copy(paprika = it) }
            ToggleRow("Bitquery", draft.bitquery) { draft = draft.copy(bitquery = it) }
        }
        Group("Alerts") {
            ToggleRow("Near misses", draft.near) { draft = draft.copy(near = it) }
            ToggleRow("Fills", draft.fills) { draft = draft.copy(fills = it) }
            ToggleRow("Stops", draft.stops) { draft = draft.copy(stops = it) }
            ExactSlider("PnL alert %", draft.alert, 0f..50f, 1f, { "%.0f".format(it) }) { draft = draft.copy(alert = it) }
            Text("0 turns the PnL alert off.", color = Dim, fontSize = 12.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    onSave(payload(draft))
                    saved = draft
                },
                enabled = dirty && snap != null,
                colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
            ) { Text("Save") }
            TextButton(onClick = { draft = saved }, enabled = dirty) { Text("Reset", color = Dim) }
        }
    }
}

private fun payload(draft: Draft): Map<String, Any?> = mapOf(
    "minVolume1hUsd" to draft.volume.toDouble(),
    "analystMinScore" to draft.score.toDouble(),
    "maxTop10Pct" to draft.top10.toDouble(),
    "maxPositionPct" to draft.position.toDouble(),
    "maxEntrySlippage" to draft.slip.toDouble(),
    "defaultBuyUsd" to if (draft.useCap) null else draft.buy.toDouble(),
    "maxOpenPositions" to draft.open.toInt(),
    "allowUnlockedLp" to draft.unlocked,
    "minLiquidityUsd" to draft.liquidity.toDouble(),
    "minTokenAgeMin" to draft.minAge.toDouble(),
    "maxTokenAgeMin" to draft.maxAge.toDouble(),
    "minHolderCount" to draft.holders.toDouble(),
    "maxDevHoldingPct" to draft.dev.toDouble(),
    "maxTradesPerHour" to draft.rate.toDouble(),
    "dailyMaxLossUsd" to draft.dailyLoss.toDouble(),
    "cooldownHours" to draft.cooldown.toDouble(),
    "stopLossPct" to draft.stop.toDouble(),
    "trailArmPct" to draft.arm.toDouble(),
    "trailGapPct" to draft.gap.toDouble(),
    "trailTakeProfit" to draft.trail,
    "autoBuy" to draft.autoBuy,
    "scoutDexscreener" to draft.dex,
    "scoutGecko" to draft.gecko,
    "scoutJupiter" to draft.jupiter,
    "scoutDexpaprika" to draft.paprika,
    "scoutBitquery" to draft.bitquery,
    "notifyNearMiss" to draft.near,
    "notifyFills" to draft.fills,
    "notifyStops" to draft.stops,
    "pnlAlertPct" to draft.alert.toDouble()
)

@Composable
private fun Group(title: String, body: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title.uppercase(), color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.2.sp)
        body()
    }
}

@Composable
private fun ExactSlider(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    step: Float,
    format: (Float) -> String,
    onChange: (Float) -> Unit
) {
    var text by remember(value) { mutableStateOf(format(value)) }
    val span = (range.endInclusive - range.start).coerceAtLeast(step)
    val steps = ((span / step).toInt() - 1).coerceAtLeast(0)
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Ink, fontSize = 14.sp, modifier = Modifier.weight(1f))
            Text(format(value), color = Lime, fontFamily = FontFamily.Monospace, fontSize = 14.sp)
        }
        Slider(
            value = value.coerceIn(range.start, range.endInclusive),
            onValueChange = {
                val snapped = range.start + kotlin.math.round((it - range.start) / step) * step
                onChange(snapped.coerceIn(range.start, range.endInclusive))
            },
            valueRange = range,
            steps = steps
        )
        OutlinedTextField(
            value = text,
            onValueChange = { raw ->
                text = raw.filter { ch -> ch.isDigit() || ch == '.' }
                val parsed = text.toFloatOrNull()
                if (parsed != null && parsed.isFinite()) onChange(parsed.coerceIn(range.start, range.endInclusive))
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Type exact") }
        )
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Ink, modifier = Modifier.weight(1f), fontSize = 15.sp)
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = label != "Pump",
            colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = Night)
        )
    }
}
