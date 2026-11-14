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
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import kotlinx.coroutines.launch
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.PerfRow
import com.dirk.nightdesk.Perf
import com.dirk.nightdesk.Strategy
import com.dirk.nightdesk.StrategyView
import com.dirk.nightdesk.VariantScore
import java.util.Locale

/**
 * Engine tab: the trading engine's switch, sizes, the shadow books and the pipeline timings.
 * v13.40: one variant can also trade the live wallet. That is off until the owner confirms it
 * here, and it never bypasses the desk's live checklist, live size or daily cap.
 */
@Composable
fun EngineScreen(
    view: StrategyView?,
    perf: List<PerfRow>,
    onStrategy: (Map<String, Any?>) -> Unit,
    onReset: () -> Unit,
    /** Engine positions on the main paper book. */
    mainOpen: Int = view?.mainOpen?.coerceAtLeast(0) ?: 0,
    /** v13.41 fetches /api/market/replay. Null where there is no desk to ask (previews). */
    onReplay: (suspend () -> Result<String>)? = null
) {
    var replay by remember { mutableStateOf<com.dirk.nightdesk.ReplayView?>(null) }
    var replayBusy by remember { mutableStateOf(false) }
    var replayError by remember { mutableStateOf<String?>(null) }
    val replayScope = androidx.compose.runtime.rememberCoroutineScope()
    var askReset by remember { mutableStateOf(false) }
    var askLive by remember { mutableStateOf<VariantScore?>(null) }
    // A tap steps from the value on screen, not from the last snapshot, so quick taps add up.
    // The pending value is dropped once the desk reports it, or after 6 s if it never does.
    var pendingTrade by remember { mutableStateOf<Double?>(null) }
    var pendingTarget by remember { mutableStateOf<Double?>(null) }
    var pendingOpen by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(view?.tradeUsd, pendingTrade) {
        if (pendingTrade != null && pendingTrade == view?.tradeUsd) pendingTrade = null
        else if (pendingTrade != null) { delay(6_000); pendingTrade = null }
    }
    LaunchedEffect(view?.targetNetUsd, pendingTarget) {
        if (pendingTarget != null && pendingTarget == view?.targetNetUsd) pendingTarget = null
        else if (pendingTarget != null) { delay(6_000); pendingTarget = null }
    }
    LaunchedEffect(view?.maxOpen, pendingOpen) {
        if (pendingOpen != null && pendingOpen == view?.maxOpen) pendingOpen = null
        else if (pendingOpen != null) { delay(6_000); pendingOpen = null }
    }
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Engine", color = P.ink, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                if (view != null) {
                    val liveOn = view.enabled && view.liveVariant.isNotBlank()
                    Chip(if (liveOn) "ON · LIVE" else if (view.enabled) "ON · PAPER" else "OFF", if (liveOn) P.onDown else if (view.enabled) P.onUp else P.muted, if (liveOn) P.down else if (view.enabled) P.up else P.card3, size = 11)
                }
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
                    Stat("Open", "$mainOpen")
                }
            }
        }
        if (view.liveSupported) {
            item {
                val liveRow = view.variants.firstOrNull { it.live }
                val top = Strategy.topEarner(view)
                Section("Live money", trailing = if (liveRow != null) "ON" else "off", padded = true) {
                    if (liveRow != null) {
                        Text(Strategy.label(liveRow), color = P.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        Text(
                            "Trading real money: $" + "%.2f".format(Locale.US, view.liveTradeUsd) + " a trade, take-profit about $" + "%.2f".format(Locale.US, view.liveTargetUsd) + " net. " + Strategy.liveOpenLine(view),
                            color = P.muted, fontSize = 12.sp, lineHeight = 16.sp
                        )
                        if (view.liveBlocked.isNotBlank()) Text("Not buying: ${view.liveBlocked}", color = P.down, fontSize = 12.sp, lineHeight = 16.sp, modifier = Modifier.padding(top = 4.dp))
                        val why = Strategy.liveStatus(view, System.currentTimeMillis())
                        if (why.isNotBlank()) Text(why, color = if (view.liveBuys > 0 && view.liveSkipAt < view.liveLastBuyAt) P.muted else P.down, fontSize = 12.sp, lineHeight = 16.sp, modifier = Modifier.padding(top = 4.dp).testTag("engine-live-why"))
                        TextButton(onClick = { onStrategy(mapOf("liveVariant" to null)) }, modifier = Modifier.testTag("engine-live-off")) {
                            Text("Turn live off", color = P.down, fontWeight = FontWeight.Bold)
                        }
                    } else {
                        Text(
                            if (top != null) "Top earner on paper: ${Strategy.label(top)}, net ${Strategy.signedUsd(top.netUsd)} over ${top.trades} trades."
                            else "No variant has closed a trade in profit yet. You can still pick one with Go live on its row.",
                            color = P.ink, fontSize = 13.sp, lineHeight = 17.sp
                        )
                        Text("Off: the engine trades paper only.", color = P.muted, fontSize = 12.sp)
                        if (top != null) {
                            TextButton(onClick = { askLive = top }, modifier = Modifier.testTag("engine-live-top")) {
                                Text("Go live with the top earner", color = P.down, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
        item {
            Section("Sizing", padded = true) {
                val trade = pendingTrade ?: view.tradeUsd
                val target = pendingTarget ?: view.targetNetUsd
                val open = pendingOpen ?: view.maxOpen
                fun setTrade(delta: Double) {
                    val next = Strategy.step(trade, delta, 5.0, 500.0)
                    if (next != trade) { pendingTrade = next; onStrategy(mapOf("tradeUsd" to next)) }
                }
                fun setTarget(delta: Double) {
                    val next = Strategy.step(target, delta, 0.25, 50.0)
                    if (next != target) { pendingTarget = next; onStrategy(mapOf("targetNetUsd" to next)) }
                }
                fun setOpen(delta: Int) {
                    val next = (open + delta).coerceIn(1, 6)
                    if (next != open) { pendingOpen = next; onStrategy(mapOf("maxOpen" to next)) }
                }
                Stepper("Trade size", "$" + "%.0f".format(Locale.US, trade), onMinus = { setTrade(-5.0) }, onPlus = { setTrade(5.0) })
                Stepper("Take-profit, net", "$" + "%.2f".format(Locale.US, target), onMinus = { setTarget(-0.5) }, onPlus = { setTarget(0.5) })
                Stepper("Max open", "$open", onMinus = { setOpen(-1) }, onPlus = { setOpen(1) })
                Text("These are the paper sizes. New paper buys pause once the paper book is $10 down on the day. Live uses the live trade size from Settings.", color = P.muted, fontSize = 12.sp)
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
                        VariantRow(row, onLive = if (view.liveSupported && !row.live) ({ askLive = row }) else null) { onStrategy(mapOf("active" to mapOf(row.signal to row.variant))) }
                        if (i < rows.lastIndex) RowDivider()
                    }
                }
            }
        }
        if (Strategy.recordingLine(view).isNotBlank()) {
            item {
                Section("Saved market data", padded = true) {
                    Text(Strategy.recordingLine(view), color = P.muted, fontSize = 12.sp, lineHeight = 16.sp, modifier = Modifier.testTag("engine-recording"))
                    if (onReplay != null) {
                        TextButton(
                            enabled = !replayBusy,
                            onClick = {
                                replayBusy = true
                                replayError = null
                                replayScope.launch {
                                    val result = onReplay()
                                    replay = result.getOrNull()?.let { Strategy.parseReplay(it) }
                                    replayError = if (replay == null) (result.exceptionOrNull()?.message ?: "The desk did not return a replay.") else null
                                    replayBusy = false
                                }
                            },
                            modifier = Modifier.testTag("engine-replay")
                        ) { Text(if (replayBusy) "Testing…" else "Test exit rules on the last 3 days", color = P.accent, fontWeight = FontWeight.Bold) }
                    }
                    replayError?.let { Text(it, color = P.down, fontSize = 12.sp) }
                    replay?.let { out ->
                        Text(out.note, color = P.ink, fontSize = 12.sp, lineHeight = 16.sp)
                        val shown = out.rows.filter { it.trades > 0 }.take(6)
                        for (row in shown) {
                            Column(Modifier.padding(top = 8.dp)) {
                                Text(Strategy.replayTitle(row), color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                Text(Strategy.replayStats(row), color = pnlTint(row.netUsd), fontSize = 12.sp)
                            }
                        }
                    }
                }
            }
        }
        item {
            Text(
                "In use: the rules the main paper book trades with. Trail: at the target the trade is not sold; the stop follows the high. Fade: also sells when volume dries up, sellers lead, the price stalls or the pool drains. Ready: ${view.readyTrades}+ trades with a net profit; it is information and arms nothing. " + view.note,
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
    askLive?.let { row ->
        AlertDialog(
            onDismissRequest = { askLive = null },
            containerColor = P.card,
            titleContentColor = P.ink,
            textContentColor = P.ink,
            title = { Text("Trade real money?") },
            text = { Text(Strategy.liveWarning(view ?: return@AlertDialog, row)) },
            confirmButton = { TextButton(onClick = { askLive = null; onStrategy(mapOf("liveVariant" to row.variant)) }, modifier = Modifier.testTag("engine-live-confirm")) { Text("Go live", color = P.down, fontWeight = FontWeight.Bold) } },
            dismissButton = { TextButton(onClick = { askLive = null }) { Text("Cancel", color = P.muted) } }
        )
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
private fun VariantRow(row: VariantScore, onLive: (() -> Unit)? = null, onUse: () -> Unit) {
    val tint = if (row.trades <= 0) P.muted else pnlTint(row.netUsd)
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(if (row.active) P.accent else P.line))
            Text(Strategy.rules(row), color = P.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (row.live) Chip("LIVE", P.onDown, P.down, size = 10)
            if (row.ready) Chip("Ready", P.onUp, P.up, size = 10)
            if (row.active) Chip("In use", P.accent, P.accent.copy(alpha = 0.16f), size = 10)
            else Text("Use", color = P.accent, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable(onClick = onUse).padding(horizontal = 6.dp, vertical = 4.dp))
            if (onLive != null) Text("Go live", color = P.down, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable(onClick = onLive).padding(horizontal = 6.dp, vertical = 4.dp))
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Stat("Net", if (row.trades > 0) Strategy.signedUsd(row.netUsd) else "—", tint, big = true)
            Stat("Trades", "${row.trades}" + (if (row.open > 0) " · ${row.open} held" else ""))
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
