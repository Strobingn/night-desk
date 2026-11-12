package com.dirk.nightdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.DeskNotice
import com.dirk.nightdesk.PerfRow
import com.dirk.nightdesk.Perf
import com.dirk.nightdesk.Strategy
import com.dirk.nightdesk.StrategyView
import com.dirk.nightdesk.VariantScore
import java.util.Locale
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.launch

/**
 * v13.32 Engine tab: the trading engine's switch, sizes, the six shadow books and the
 * pipeline timings. Everything here is paper. Nothing on this screen can arm live trading.
 */
@Composable
fun EngineScreen(
    view: StrategyView?,
    perf: List<PerfRow>,
    onStrategy: (Map<String, Any?>) -> Deferred<DeskNotice>,
    onReset: () -> Unit
) {
    var askReset by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val latestView by rememberUpdatedState(view)
    // The desk snapshot is not updated until the save returns, so a second tap in that
    // window would otherwise repeat the first absolute value. These locals step immediately.
    var tradeUsd by remember { mutableStateOf(view?.tradeUsd ?: 0.0) }
    var seenTrade by remember { mutableStateOf(view?.tradeUsd ?: 0.0) }
    var tradeGen by remember { mutableIntStateOf(0) }
    var targetNet by remember { mutableStateOf(view?.targetNetUsd ?: 0.0) }
    var seenTarget by remember { mutableStateOf(view?.targetNetUsd ?: 0.0) }
    var targetGen by remember { mutableIntStateOf(0) }
    var maxOpen by remember { mutableIntStateOf(view?.maxOpen ?: 0) }
    var seenOpen by remember { mutableIntStateOf(view?.maxOpen ?: 0) }
    var openGen by remember { mutableIntStateOf(0) }
    if (view != null) {
        val trade = Strategy.adoptStepper(tradeUsd, seenTrade, view.tradeUsd)
        if (trade.first != tradeUsd) tradeUsd = trade.first
        if (trade.second != seenTrade) seenTrade = trade.second
        val target = Strategy.adoptStepper(targetNet, seenTarget, view.targetNetUsd)
        if (target.first != targetNet) targetNet = target.first
        if (target.second != seenTarget) seenTarget = target.second
        val open = Strategy.adoptStepper(maxOpen.toDouble(), seenOpen.toDouble(), view.maxOpen.toDouble())
        if (open.first.toInt() != maxOpen) maxOpen = open.first.toInt()
        if (open.second.toInt() != seenOpen) seenOpen = open.second.toInt()
    }
    fun launchStep(
        current: Double,
        delta: Double,
        min: Double,
        max: Double,
        gen: () -> Int,
        setGen: (Int) -> Unit,
        setShown: (Double) -> Unit,
        setSeen: (Double) -> Unit,
        fallback: () -> Double?,
        patch: (Double) -> Map<String, Any?>
    ) {
        val next = Strategy.stepBound(current, delta, min, max)
        if (next == current) return
        setShown(next)
        val ticket = gen() + 1
        setGen(ticket)
        val job = onStrategy(patch(next))
        scope.launch {
            val notice = job.await()
            if (!notice.ok && gen() == ticket) {
                fallback()?.let {
                    setShown(it)
                    setSeen(it)
                }
            }
        }
    }
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Engine", color = P.ink, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                if (view != null) Chip(if (view.enabled) "ON · PAPER" else "OFF", if (view.enabled) P.onUp else P.muted, if (view.enabled) P.up else P.card3, size = 11)
            }
        }
        if (view == null) {
            item {
                Section("Trading engine", padded = true) {
                    Text("This desk does not have the trading engine. Update the desk to 13.30 or later.", color = P.muted, fontSize = 13.sp)
                }
            }
            return@LazyColumn
        }
        item {
            Section("Switch", padded = true) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Engine on", color = P.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (view.enabled) "Coins that pass Filter and Analyst are watched for a Launch or Momentum signal, then bought on paper."
                            else "Off: an Analyst pass is bought on sight and winners are closed by hand.",
                            color = P.muted,
                            fontSize = 12.sp,
                            lineHeight = 16.sp
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Switch(
                        checked = view.enabled,
                        onCheckedChange = { onStrategy(mapOf("enabled" to it)) },
                        colors = SwitchDefaults.colors(checkedTrackColor = P.accent, checkedThumbColor = P.onAccent, uncheckedTrackColor = P.card3, uncheckedThumbColor = P.muted, uncheckedBorderColor = P.lineStrong)
                    )
                }
                Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                    Stat("Watching", "${view.watching}")
                    Stat("Signals", "${view.signals}")
                    Stat("Open", "${view.variants.filter { it.active }.sumOf { it.open }}")
                }
            }
        }
        item {
            Section("Sizing", padded = true) {
                Stepper(
                    "Trade size",
                    "$" + "%.0f".format(Locale.US, tradeUsd),
                    onMinus = { launchStep(tradeUsd, -5.0, 5.0, 500.0, { tradeGen }, { tradeGen = it }, { tradeUsd = it }, { seenTrade = it }, { latestView?.tradeUsd }) { mapOf("tradeUsd" to it) } },
                    onPlus = { launchStep(tradeUsd, 5.0, 5.0, 500.0, { tradeGen }, { tradeGen = it }, { tradeUsd = it }, { seenTrade = it }, { latestView?.tradeUsd }) { mapOf("tradeUsd" to it) } }
                )
                Stepper(
                    "Take-profit, net",
                    "$" + "%.2f".format(Locale.US, targetNet),
                    onMinus = { launchStep(targetNet, -0.5, 0.25, 50.0, { targetGen }, { targetGen = it }, { targetNet = it }, { seenTarget = it }, { latestView?.targetNetUsd }) { mapOf("targetNetUsd" to it) } },
                    onPlus = { launchStep(targetNet, 0.5, 0.25, 50.0, { targetGen }, { targetGen = it }, { targetNet = it }, { seenTarget = it }, { latestView?.targetNetUsd }) { mapOf("targetNetUsd" to it) } }
                )
                Stepper(
                    "Max open",
                    "$maxOpen",
                    onMinus = { launchStep(maxOpen.toDouble(), -1.0, 1.0, 6.0, { openGen }, { openGen = it }, { maxOpen = it.toInt() }, { seenOpen = it.toInt() }, { latestView?.maxOpen?.toDouble() }) { mapOf("maxOpen" to it.toInt()) } },
                    onPlus = { launchStep(maxOpen.toDouble(), 1.0, 1.0, 6.0, { openGen }, { openGen = it }, { maxOpen = it.toInt() }, { seenOpen = it.toInt() }, { latestView?.maxOpen?.toDouble() }) { mapOf("maxOpen" to it.toInt()) } }
                )
                Text("Paper only. New engine buys pause once the paper book is $10 down on the day.", color = P.muted, fontSize = 12.sp)
            }
        }
        item {
            Text("SCORECARD", color = P.faint, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.padding(start = 2.dp, top = 4.dp))
        }
        for (signal in listOf("launch", "momentum")) {
            val rows = view.variants.filter { it.signal == signal }
            if (rows.isEmpty()) continue
            item {
                Section(
                    if (signal == "launch") "Launch · under 30 min old" else "Momentum · 30 min and older",
                    trailing = "${rows.sumOf { it.trades }} trades"
                ) {
                    rows.forEachIndexed { i, row ->
                        VariantRow(row) { onStrategy(mapOf("active" to mapOf(row.signal to row.variant))) }
                        if (i < rows.lastIndex) RowDivider()
                    }
                }
            }
        }
        item {
            Text(
                "In use: the stop the main paper book trades with. Ready: ${view.readyTrades}+ trades with a net profit; it is information and arms nothing. " + view.note,
                color = P.muted,
                fontSize = 12.sp,
                lineHeight = 16.sp
            )
        }
        if (perf.isNotEmpty()) {
            item {
                Section("Pipeline timing", trailing = "median · 90th") {
                    perf.forEachIndexed { i, row ->
                        ListRow(Perf.label(row.step), "${row.count} samples · worst ${Perf.ms(row.maxMs)}", trailing = {
                            Text("${Perf.ms(row.p50Ms)} · ${Perf.ms(row.p90Ms)}", color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        })
                        if (i < perf.lastIndex) RowDivider()
                    }
                }
            }
        }
        item {
            TextButton(onClick = { askReset = true }) { Text("Reset scorecard", color = P.down, fontWeight = FontWeight.SemiBold) }
        }
    }
    if (askReset) {
        AlertDialog(
            onDismissRequest = { askReset = false },
            containerColor = P.card,
            titleContentColor = P.ink,
            textContentColor = P.ink,
            title = { Text("Reset the scorecard?") },
            text = { Text("Every shadow book goes back to $100 and its trades are deleted. The main paper book is not touched.") },
            confirmButton = { TextButton(onClick = { askReset = false; onReset() }) { Text("Reset", color = P.down, fontWeight = FontWeight.Bold) } },
            dismissButton = { TextButton(onClick = { askReset = false }) { Text("Cancel", color = P.muted) } }
        )
    }
}

@Composable
private fun VariantRow(row: VariantScore, onUse: () -> Unit) {
    val tint = if (row.trades <= 0) P.muted else pnlTint(row.netUsd)
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(if (row.active) P.accent else P.line))
            Text("${"%.0f".format(Locale.US, row.stopPct * 100)}% stop", color = P.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (row.ready) Chip("Ready", P.onUp, P.up, size = 10)
            if (row.active) Chip("In use", P.accent, P.accent.copy(alpha = 0.16f), size = 10)
            else Text("Use", color = P.accent, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable(onClick = onUse).padding(horizontal = 6.dp, vertical = 4.dp))
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Stat("Net", if (row.trades > 0) Strategy.signedUsd(row.netUsd) else "—", tint, big = true)
            Stat("Trades", "${row.trades}" + (if (row.open > 0) " · ${row.open} open" else ""))
            Stat("Win", if (row.trades > 0) "%.0f%%".format(Locale.US, row.winRate * 100) else "—")
            Stat("Avg", if (row.trades > 0) Strategy.signedUsd(row.avgNetUsd) else "—", tint)
        }
        if (row.trades > 0) {
            Text(
                "avg win ${Strategy.signedUsd(row.avgWinUsd)} · avg loss ${Strategy.signedUsd(row.avgLossUsd)} · worst drawdown $" + "%.2f".format(Locale.US, row.maxDrawdownUsd),
                color = P.muted,
                fontSize = 11.5.sp,
                modifier = Modifier.padding(top = 4.dp)
            )
        }
    }
}

@Composable
private fun Stepper(label: String, value: String, onMinus: () -> Unit, onPlus: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = P.ink, fontSize = 14.sp, modifier = Modifier.weight(1f))
        StepButton("−", onMinus)
        Text(value, color = P.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp))
        StepButton("+", onPlus)
    }
}

@Composable
private fun StepButton(glyph: String, onClick: () -> Unit) {
    Box(
        Modifier.size(34.dp).clip(CircleShape).background(P.card3).clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) { Text(glyph, color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold) }
}
