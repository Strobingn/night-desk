package com.dirk.nightdesk.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextOverflow
import com.dirk.nightdesk.AdviceNote
import com.dirk.nightdesk.FeedSource
import com.dirk.nightdesk.feedSourceRateText
import com.dirk.nightdesk.feedSourceStateText
import com.dirk.nightdesk.CrashLog
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.formatUsd
import com.dirk.nightdesk.DeskSnapshot
import com.dirk.nightdesk.LiveReadiness
import com.dirk.nightdesk.MintCooldown
import com.dirk.nightdesk.PositionRow
import com.dirk.nightdesk.TapeEvent
import com.dirk.nightdesk.TapeFollowInput
import com.dirk.nightdesk.TapeFollowState
import com.dirk.nightdesk.countNewSince
import com.dirk.nightdesk.pausedLabel
import com.dirk.nightdesk.stepTapeFollow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val stages = listOf("all", "scout", "filter", "analyst", "executor", "risk", "system")

@Composable
fun NightDeskApp(desk: DeskRepository) {
    val snap by desk.snapshot.collectAsState()
    val status by desk.status.collectAsState()
    val live by desk.live.collectAsState()
    val error by desk.error.collectAsState()
    val lastGood by desk.lastGoodUrl.collectAsState()
    val activeUrl by desk.activeUrl.collectAsState()
    val notice by desk.notice.collectAsState()
    val hardKill by desk.hardKillAsk.collectAsState()
    val shared by desk.sharedCoin.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var addPrefill by remember { mutableStateOf<Pair<String, Int>?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(shared) {
        val coin = desk.consumeSharedCoin()
        if (coin != null) {
            addPrefill = coin to ((addPrefill?.second ?: 0) + 1)
            tab = 2
        }
    }

    LaunchedEffect(Unit) {
        desk.boot()
    }

    Scaffold(
        containerColor = Night,
        bottomBar = {
            NavigationBar(containerColor = Color(0xFF10140E)) {
                listOf("Home", "Tape", "Add coin", "Recap", "Settings", "Link").forEachIndexed { index, label ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        label = { Text(label, fontSize = 11.sp, maxLines = 1) },
                        icon = {},
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = Lime,
                            selectedTextColor = Lime,
                            unselectedTextColor = Dim,
                            indicatorColor = Color(0xFF1C2416)
                        )
                    )
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).background(Night)) {
            Header(status = status, live = live, mode = snap?.mode ?: "paper")
            snap?.feedBanner?.let { banner ->
                StatusPill(text = "Feed: $banner", tint = Amber)
            }
            if (!error.isNullOrBlank() || (!live && status.startsWith("Reconnecting"))) {
                ConnectionPill(
                    message = shortConnectionError(error, status),
                    canUseLastGood = !lastGood.isNullOrBlank() && lastGood != activeUrl,
                    onUseLastGood = { scope.launch { desk.useLastGood() } },
                    onEditLink = { tab = 5 }
                )
            }
            notice?.let { note ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        note.text,
                        color = if (note.ok) Mint else Coral,
                        modifier = Modifier.weight(1f),
                        fontSize = 13.sp
                    )
                    TextButton(onClick = { desk.dismissNotice() }) { Text("Dismiss", color = Dim) }
                }
            }
            when (tab) {
                0 -> BookScreen(
                    snap,
                    onClose = { mint -> scope.launch { desk.closePosition(mint) } },
                    onSell = { mint, percent -> scope.launch { desk.sellPosition(mint, percent) } },
                    onReset = { scope.launch { desk.resetPaperBook() } },
                    onReady = { ready -> scope.launch { desk.setOperatorReady(ready) } },
                    onBuy = { mint, ignore -> scope.launch { desk.buyPosition(mint, null, ignore) } }
                )
                1 -> TapeScreen(
                    snap?.events.orEmpty(),
                    positionCapUsd = snap?.positionCapUsd,
                    cooldowns = snap?.cooldowns.orEmpty(),
                    onBuy = { mint, size, ignore -> scope.launch { desk.buyPosition(mint, size, ignore) } },
                    feedSources = snap?.feedSources.orEmpty()
                )
                2 -> AddCoinScreen(desk, snap, addPrefill)
                3 -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) { RecapCard(desk) }
                4 -> SettingsScreen(snap) { patch -> scope.launch { desk.saveSettings(patch) } }
                else -> LinkScreen(desk)
            }
        }
    }
    val ask = hardKill
    if (ask != null) {
        AlertDialog(
            onDismissRequest = { desk.dismissHardKill() },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text("Buy ${ask.symbol} anyway?") },
            text = {
                Text(ask.message + "\n\nPaper fill only. Slippage cap, pool depth, cash and the hard stop still apply.")
            },
            confirmButton = {
                TextButton(onClick = {
                    desk.dismissHardKill()
                    scope.launch { desk.buyPosition(ask.mint, ask.sizeUsd, ignoreCooldown = true, confirmHardKill = true, confirmSize = ask.confirmSize, symbol = ask.symbol) }
                }) { Text("Buy anyway", color = Coral) }
            },
            dismissButton = {
                TextButton(onClick = { desk.dismissHardKill() }) { Text("Cancel", color = Dim) }
            }
        )
    }
}

@Composable
private fun Header(status: String, live: Boolean, mode: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text("NIGHT DESK", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
            Text(if (live) "Feed live · $status" else status, color = if (live) Mint else Dim, fontSize = 12.sp)
        }
        Text(mode.uppercase(), color = Lime, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun BookScreen(
    snap: DeskSnapshot?,
    onClose: (String) -> Unit,
    onSell: (String, Int) -> Unit,
    onReset: () -> Unit,
    onReady: (Boolean) -> Unit,
    onBuy: (String, Boolean) -> Unit
) {
    val openPnl = snap?.positions?.sumOf { it.pnlUsd } ?: 0.0
    LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { LastCrashCard() }
        if (!snap?.lastClientCrash.isNullOrBlank()) {
            item {
                Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
                    Text("LAST CRASH ON THE DESK", color = Coral, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    Text(snap?.lastClientCrash.orEmpty().take(400), color = Dim, fontSize = 12.sp)
                }
            }
        }
        item {
            Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
                Text("OPEN POSITIONS", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 1.4.sp)
                Text(
                    signed(openPnl),
                    color = if (openPnl >= 0) Mint else Coral,
                    fontSize = 32.sp,
                    fontFamily = FontFamily.Monospace
                )
                Text("Total open PnL", color = Dim, fontSize = 13.sp)
            }
        }
        if (snap == null || snap.positions.isEmpty()) {
            item {
                Text(
                    "No open positions. A name still has to clear every hard filter.",
                    color = Dim,
                    fontSize = 15.sp,
                    modifier = Modifier.padding(vertical = 8.dp)
                )
            }
        } else {
            itemsIndexed(snap.positions, key = { index, pos -> "${pos.mint}#$index" }) { _, pos ->
                OpenPositionCard(pos, onClose, onSell)
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Metric("Equity", money(snap?.equityUsd), Modifier.weight(1f))
                Metric("Cash", money(snap?.cashUsd), Modifier.weight(1f))
            }
        }
        item {
            Text(
                signed(snap?.sessionPnlUsd ?: 0.0) + " session",
                color = if ((snap?.sessionPnlUsd ?: 0.0) >= 0) Mint else Coral,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
        item { LiveReadyCard(snap?.readiness, onReady) }
        item { AdvisorCard(snap?.advice.orEmpty(), snap?.cooldowns.orEmpty(), onBuy) }
        if (snap?.mode != "live") {
            item { ResetCard(snap?.paperResetUsd ?: 100.0, onReset) }
        }
        item { Text("Recent trades", style = androidx.compose.material3.MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
        val recent = snap?.closed.orEmpty().takeLast(20).asReversed()
        if (recent.isEmpty()) {
            item { Text("No realized trades yet. Hard stops and manual closes land here.", color = Dim, modifier = Modifier.padding(bottom = 24.dp)) }
        } else {
            itemsIndexed(recent, key = { index, trade -> "${trade.id}#$index" }) { _, trade ->
                Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(12.dp)).padding(12.dp)) {
                    Text(trade.symbol, color = Ink, fontWeight = FontWeight.SemiBold)
                    Text(
                        "entry ${px(trade.entryPrice)} → exit ${px(trade.exitPrice)} · ${trade.exitCode} · ${clock(trade.closedAt)}",
                        color = Dim,
                        fontSize = 12.sp
                    )
                    Text(money(trade.pnlUsd), color = if (trade.pnlUsd >= 0) Mint else Coral, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecapCard(desk: DeskRepository) {
    val windows = listOf("12h" to "12h", "24h" to "24h", "7d" to "7d", "reset" to "Since reset")
    var window by rememberSaveable { mutableStateOf("12h") }
    var text by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("RECAP", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text("Stops at the last paper reset.", color = Dim, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            windows.forEach { (id, label) ->
                FilterChip(selected = window == id, onClick = { window = id }, label = { Text(label) })
            }
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    val result = desk.loadRecap(window)
                    busy = false
                    result.fold(
                        onSuccess = {
                            text = it
                            error = null
                        },
                        onFailure = {
                            text = null
                            error = it.message ?: "Recap failed"
                        }
                    )
                }
            },
            enabled = !busy,
            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Color(0xFF14180F))
        ) { Text(if (busy) "Loading" else if (text == null) "Recap" else "Refresh recap") }
        if (!error.isNullOrBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(error ?: "", color = Coral, fontSize = 13.sp)
        }
        if (!text.isNullOrBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(
                text ?: "",
                color = Ink,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                modifier = Modifier.fillMaxWidth().height(220.dp).verticalScroll(rememberScrollState())
            )
        }
    }
}

@Composable
private fun LiveReadyCard(readiness: LiveReadiness?, onReady: (Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Color(0xFF171E12), RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("LIVE READY", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text(if (readiness?.mode == "live") "LIVE" else "STILL PAPER", color = Ink, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        if (readiness == null || readiness.lines.isEmpty()) {
            Text("Waiting for the desk checklist.", color = Dim, fontSize = 13.sp)
        } else {
            readiness.lines.forEach { line ->
                Text(line, color = Ink, fontSize = 13.sp, modifier = Modifier.padding(bottom = 4.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text("Mark checklist ready", color = Ink, modifier = Modifier.weight(1f), fontSize = 14.sp)
            Switch(
                checked = readiness?.operatorReady == true,
                onCheckedChange = onReady,
                enabled = readiness != null,
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = Night)
            )
        }
        Text(
            "This note does not enable live trading and does not save a Phantom seed. The trading keypair stays on the Austin desk host. Night Desk has no wallet vault.",
            color = Dim,
            fontSize = 12.sp
        )
    }
}

@Composable
private fun AdvisorCard(notes: List<AdviceNote>, cooldowns: List<MintCooldown>, onBuy: (String, Boolean) -> Unit) {
    var confirmMint by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().background(Color(0xFF171E12), RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("ADVISOR", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text("Follows the feed. A near miss is your call.", color = Dim, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        if (notes.isEmpty()) {
            Text("Waiting for the next mark.", color = Ink)
        } else {
            notes.forEach { note ->
                Column(Modifier.padding(vertical = 6.dp)) {
                    Row {
                        Text(note.stance.uppercase(), color = stanceColor(note.stance), fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.width(78.dp))
                        Text(note.text, color = Ink, fontSize = 14.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f))
                    }
                    if (note.stance == "near-miss" && !note.mint.isNullOrBlank()) {
                        TextButton(onClick = {
                            val banned = cooldowns.any { it.mint == note.mint }
                            if (banned) confirmMint = note.mint else onBuy(note.mint, false)
                        }) { Text("Buy", color = Lime) }
                    }
                }
            }
        }
    }
    val pending = confirmMint
    if (pending != null) {
        val ban = cooldowns.firstOrNull { it.mint == pending }
        AlertDialog(
            onDismissRequest = { confirmMint = null },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text("Buy anyway?") },
            text = {
                Text("Mint is banned after a hard stop. Cooldown has about ${ban?.minutesLeft ?: 0} minute(s) left. Auto buys stay blocked.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmMint = null
                    onBuy(pending, true)
                }) { Text("Buy anyway", color = Lime) }
            },
            dismissButton = {
                TextButton(onClick = { confirmMint = null }) { Text("Cancel", color = Dim) }
            }
        )
    }
}

@Composable
private fun ResetCard(amountUsd: Double, onReset: () -> Unit) {
    val amount = "$" + "%,.0f".format(Locale.US, amountUsd)
    var ask by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("PAPER BOOK", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text("Reset drops open positions and starts cash at $amount.", color = Ink, fontSize = 13.sp)
        TextButton(onClick = { ask = true }) { Text("Reset book", color = Amber) }
    }
    if (ask) {
        AlertDialog(
            onDismissRequest = { ask = false },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text("Reset paper book?") },
            text = {
                Text("Open positions are dropped and session PnL starts over at $amount. No order is sent. The log, advisor memory, and volume floor stay. Live trading stays off.")
            },
            confirmButton = {
                TextButton(onClick = {
                    ask = false
                    onReset()
                }) { Text("Reset to $amount", color = Amber) }
            },
            dismissButton = {
                TextButton(onClick = { ask = false }) { Text("Keep book", color = Lime) }
            }
        )
    }
}

@Composable
private fun ScoreCard(current: Double, onSave: (Map<String, Any?>) -> Unit) {
    SettingCard(
        title = "ANALYST TRADE LINE",
        valueText = "%.2f".format(java.util.Locale.US, current),
        detail = "Score floor for a new buy (0.10–0.95)",
        keyboard = KeyboardType.Decimal,
        digitsOnly = false,
        onApply = { text -> onSave(mapOf("analystMinScore" to (text.toDoubleOrNull() ?: text))) }
    )
}

@Composable
private fun Top10Card(current: Double, onSave: (Map<String, Any?>) -> Unit) {
    SettingCard(
        title = "TOP 10 HOLDER CAP",
        valueText = "${(current * 100).toInt()}%",
        detail = "5% to 35%. Looser than 35% is ignored.",
        keyboard = KeyboardType.Number,
        digitsOnly = true,
        onApply = { text -> text.toDoubleOrNull()?.let { onSave(mapOf("maxTop10Pct" to it)) } }
    )
}

@Composable
private fun PositionCapCard(current: Double, onSave: (Map<String, Any?>) -> Unit) {
    val shown = (current * 1000).toInt() / 10.0
    SettingCard(
        title = "MAX POSITION %",
        valueText = if (shown % 1.0 == 0.0) shown.toInt().toString() else shown.toString(),
        detail = "Tighten only, from 1% to 8% of equity. A wider number is cut back to 8%.",
        keyboard = KeyboardType.Decimal,
        digitsOnly = false,
        onApply = { text -> text.toDoubleOrNull()?.let { onSave(mapOf("maxPositionPct" to it)) } }
    )
}

@Composable
private fun DefaultBuyCard(current: Double?, onSave: (Map<String, Any?>) -> Unit) {
    SettingCard(
        title = "DEFAULT BUY USD",
        valueText = if (current == null) "" else "%.2f".format(java.util.Locale.US, current),
        detail = "Blank uses the position cap. A size above the cap is filled at the cap.",
        keyboard = KeyboardType.Decimal,
        digitsOnly = false,
        allowBlank = true,
        onApply = { text ->
            val raw = text.trim()
            if (raw.isEmpty()) onSave(mapOf("defaultBuyUsd" to null))
            else raw.toDoubleOrNull()?.let { onSave(mapOf("defaultBuyUsd" to it)) }
        }
    )
}

@Composable
private fun OpenCountCard(current: Int, onSave: (Map<String, Any?>) -> Unit) {
    SettingCard(
        title = "MAX OPEN POSITIONS",
        valueText = current.toString(),
        detail = "1 to 24 names at once.",
        keyboard = KeyboardType.Number,
        digitsOnly = true,
        onApply = { text -> text.toIntOrNull()?.let { onSave(mapOf("maxOpenPositions" to it)) } }
    )
}

@Composable
private fun UnlockedLpCard(allowed: Boolean, onSave: (Map<String, Any?>) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("ALLOW UNLOCKED LP", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(if (allowed) "On. A lone unlocked pool can be bought." else "Off. Unlocked LP is a hard kill.", color = Ink, modifier = Modifier.weight(1f))
            Switch(
                checked = allowed,
                onCheckedChange = { onSave(mapOf("allowUnlockedLp" to it)) },
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = Night)
            )
        }
        Text("Mint authority and dev rugs stay hard kills. The −6% stop still applies.", color = Dim, fontSize = 11.sp)
    }
}

@Composable
private fun EntrySlipCard(current: Double, onSave: (Map<String, Any?>) -> Unit) {
    val shown = (current * 1000).toInt() / 10.0
    SettingCard(
        title = "MAX ENTRY SLIPPAGE",
        valueText = "${"%.1f".format(java.util.Locale.US, shown)}%",
        detail = "0.5% to 3%. A quote above this is refused. It cannot be turned off.",
        keyboard = KeyboardType.Decimal,
        digitsOnly = false,
        onApply = { text -> text.toDoubleOrNull()?.let { onSave(mapOf("maxEntrySlippage" to it)) } }
    )
}

@Composable
private fun HardStopCard(stopLossPct: Double) {
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("HARD STOP", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text("−${(stopLossPct * 100).toInt()}% from the fill", color = Ink, fontWeight = FontWeight.SemiBold)
        Text("This is fixed. The app cannot change it.", color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun SettingCard(
    title: String,
    valueText: String,
    detail: String,
    keyboard: KeyboardType,
    digitsOnly: Boolean,
    allowBlank: Boolean = false,
    onApply: (String) -> Unit
) {
    var text by remember(valueText) { mutableStateOf(valueText) }
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text(title, color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text(if (valueText.isBlank()) "Using the position cap" else valueText, color = Ink, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { next ->
                    text = next.filter { ch ->
                        when {
                            allowBlank && next.isEmpty() -> true
                            digitsOnly -> ch.isDigit()
                            else -> ch.isDigit() || ch == '.'
                        }
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = keyboard),
                modifier = Modifier.weight(1f),
                colors = fieldColors()
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = { onApply(text) }, colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)) {
                Text("Apply")
            }
        }
        Text(detail, color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun VolumeCard(current: Double, onSave: (Map<String, Any?>) -> Unit) {
    var text by remember(current) { mutableStateOf(current.toLong().toString()) }
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("1H VOLUME FLOOR", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text(money(current) + " on the next filter check", color = Ink, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.filter { ch -> ch.isDigit() } },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
                colors = fieldColors()
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = { text.toDoubleOrNull()?.let { onSave(mapOf("minVolume1hUsd" to it)) } }, colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)) {
                Text("Apply")
            }
        }
        Text("$1,000–$500,000. Default $10,000 until you change it.", color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OpenPositionCard(pos: PositionRow, onClose: (String) -> Unit, onSell: (String, Int) -> Unit = { mint, _ -> onClose(mint) }) {
    val room = stopRoom(pos)
    val up = pos.pnlUsd >= 0
    val context = LocalContext.current
    var sellAsk by remember { mutableStateOf<Int?>(null) }
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(pos.symbol, style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
            Column(horizontalAlignment = Alignment.End) {
                Text(signed(pos.pnlUsd), color = if (up) Mint else Coral, fontSize = 28.sp, fontFamily = FontFamily.Monospace)
                Text(pct(pos.pnlPct), color = if (up) Mint else Coral, fontSize = 18.sp, fontFamily = FontFamily.Monospace)
            }
        }
        val tag = pos.tag ?: if (pos.entry == "manual") "manual" else null
        if (tag != null) {
            Text(tag.uppercase(), color = Amber, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.sp)
        }
        Text("Entry ${px(pos.entryPrice)}   ·   Mark ${px(pos.markPrice)}", color = Ink, fontSize = 15.sp, modifier = Modifier.padding(top = 6.dp))
        Text("Held ${heldFor(pos.openedAt)}   ·   Size ${money(pos.costUsd)}", color = Dim, fontSize = 14.sp)
        Text("Distance to the hard stop", color = Dim, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
        LinearProgressIndicator(
            progress = { room },
            color = if (room < 0.35f) Coral else Mint,
            trackColor = Color(0xFF2A3324),
            modifier = Modifier.fillMaxWidth().height(10.dp).padding(top = 4.dp)
        )
        Text("${num(pos.stopDistancePct, "%.1f")}% under the mark before ${fmtPx(pos.stopPrice)}", color = Ink, fontSize = 13.sp)
        // v12.3: bigger, clearer sell buttons. Each one still asks first.
        Text("SELL", color = Dim, fontSize = 11.sp, letterSpacing = 1.sp, modifier = Modifier.padding(top = 12.dp))
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SellButton("Sell 25%", Amber, Modifier.weight(1f)) { sellAsk = 25 }
            SellButton("Sell 50%", Amber, Modifier.weight(1f)) { sellAsk = 50 }
            SellButton("Sell 100%", Coral, Modifier.weight(1f)) { sellAsk = 100 }
        }
        FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            chartLinks(pos.mint).forEach { (label, url) ->
                TextButton(onClick = {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                }) { Text(label, color = Sky) }
            }
        }
    }
    val pending = sellAsk
    if (pending != null) {
        AlertDialog(
            onDismissRequest = { sellAsk = null },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text(if (pending >= 100) "Sell all of ${pos.symbol}?" else "Sell $pending% of ${pos.symbol}?") },
            text = { Text("Paper fill at the mark against the same pool model as a stop. The hard stop keeps guarding what is left.") },
            confirmButton = {
                Button(
                    onClick = {
                        sellAsk = null
                        if (pending >= 100) onClose(pos.mint) else onSell(pos.mint, pending)
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Coral, contentColor = Night)
                ) { Text("Sell", fontSize = 16.sp) }
            },
            dismissButton = { TextButton(onClick = { sellAsk = null }) { Text("Cancel", color = Dim) } }
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PositionCard(pos: PositionRow, onClose: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(pos.symbol, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
            Text(signed(pos.pnlUsd), color = if (pos.pnlUsd >= 0) Mint else Coral, fontFamily = FontFamily.Monospace)
        }
        Text(
            "${if (pos.entry == "manual") "Manual buy" else pos.source}  ·  score ${num(pos.score, "%.2f")}  ·  mark ${markAge(pos.markAgeMs)}",
            color = Dim,
            fontSize = 12.sp
        )
        if (pos.lpUnlocked) Text("LP unlocked", color = Amber, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        Text("Hard stop ${fmtPx(pos.stopPrice)}  ·  ${num(pos.stopDistancePct, "%.1f")}% under the mark", color = Ink, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
        val context = LocalContext.current
        FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            chartLinks(pos.mint).forEach { (label, url) ->
                TextButton(onClick = {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                }) { Text(label, color = Sky) }
            }
        }
        TextButton(onClick = { onClose(pos.mint) }) { Text("Close", color = Coral) }
    }
}

/** Look-only feeds. Opening one does not send a desk order. */
private fun chartLinks(mint: String): List<Pair<String, String>> = listOf(
    "DexScreener" to "https://dexscreener.com/solana/$mint",
    "Birdeye" to "https://birdeye.so/token/$mint?chain=solana",
    "Jupiter" to "https://jup.ag/tokens/$mint"
)

@Composable
private fun TapeScreen(
    events: List<TapeEvent>,
    positionCapUsd: Double?,
    cooldowns: List<MintCooldown>,
    onBuy: (String, Double?, Boolean) -> Unit,
    feedSources: List<FeedSource> = emptyList()
) {
    var stage by remember { mutableStateOf("all") }
    var selected by remember { mutableStateOf<TapeEvent?>(null) }
    var askBuy by remember { mutableStateOf(false) }
    var sizeText by remember { mutableStateOf("") }
    var sizeError by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val shown = events.filter { stage == "all" || it.stage == stage }
    val capText = if (positionCapUsd != null && positionCapUsd > 0) "%.2f".format(java.util.Locale.US, positionCapUsd) else ""
    val tapeState = remember { mutableStateOf(TapeFollowState()) }
    var tape by tapeState
    val shownState = remember { mutableStateOf(shown) }
    shownState.value = shown
    val anchorId = remember { mutableStateOf<String?>(null) }
    val anchorOffset = remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val stick = remember {
        object : NestedScrollConnection {
            private fun capture() {
                val rows = shownState.value
                val id = rows.getOrNull(listState.firstVisibleItemIndex)?.id ?: return
                anchorId.value = id
                anchorOffset.intValue = listState.firstVisibleItemScrollOffset
            }

            private fun onUserMoved() {
                val rows = shownState.value
                val atEdge = !listState.canScrollForward
                val prev = tapeState.value
                val wasFollowing = !prev.held && !prev.away
                if (!atEdge) capture()
                val result = stepTapeFollow(
                    prev,
                    TapeFollowInput(ids = rows.map { it.id }, userMoved = true, atLiveEdge = atEdge)
                )
                tapeState.value = result.state
                if (result.follow && !wasFollowing && rows.isNotEmpty()) {
                    anchorId.value = null
                    scope.launch { runCatching { listState.scrollToItem(rows.lastIndex) } }
                }
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && consumed.y != 0f) onUserMoved()
                return Offset.Zero
            }

            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                onUserMoved()
                return Velocity.Zero
            }
        }
    }
    val idKey = shown.joinToString("\u0000") { it.id }
    val filterSeen = remember { mutableStateOf(stage) }
    LaunchedEffect(idKey, stage) {
        val rows = shown
        val filterChanged = filterSeen.value != stage
        filterSeen.value = stage
        val result = stepTapeFollow(
            tapeState.value,
            TapeFollowInput(ids = rows.map { it.id }, filterChanged = filterChanged)
        )
        tapeState.value = result.state
        if (result.follow) {
            anchorId.value = null
            if (!listState.isScrollInProgress && rows.isNotEmpty()) {
                val last = rows.lastIndex
                val alreadyThere = listState.firstVisibleItemIndex == last && !listState.canScrollForward
                if (!alreadyThere) runCatching { listState.scrollToItem(last) }
            }
        } else if (filterChanged) {
            anchorId.value = null
        } else if (result.anchor && !listState.isScrollInProgress) {
            val id = anchorId.value
            val index = if (id == null) -1 else rows.indexOfFirst { it.id == id }
            val samePlace = index >= 0 &&
                listState.firstVisibleItemIndex == index &&
                listState.firstVisibleItemScrollOffset == anchorOffset.intValue
            if (index >= 0 && !samePlace) runCatching { listState.scrollToItem(index, anchorOffset.intValue) }
        }
    }
    val tapePaused = tape.held || tape.away
    val fresh = countNewSince(shown.map { it.id }, tape.seenId, tapePaused)
    fun toggleTape() {
        val rows = shown
        if (tapePaused) {
            val result = stepTapeFollow(tapeState.value, TapeFollowInput(ids = rows.map { it.id }, goLive = true))
            tapeState.value = result.state
            anchorId.value = null
            scope.launch { if (rows.isNotEmpty()) runCatching { listState.scrollToItem(rows.lastIndex) } }
        } else {
            val index = listState.firstVisibleItemIndex
            val id = rows.getOrNull(index)?.id
            if (id != null) {
                anchorId.value = id
                anchorOffset.intValue = listState.firstVisibleItemScrollOffset
            }
            val result = stepTapeFollow(tapeState.value, TapeFollowInput(ids = rows.map { it.id }, pause = true))
            tapeState.value = result.state
        }
    }
    Column(Modifier.fillMaxSize()) {
        ScoutStatusCard(feedSources)
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            val mintLabel = selected?.mint
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (mintLabel == null) "Select a mint on the tape" else "Selected ${selected?.symbol ?: mintLabel.take(4)}",
                        color = Lime,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp
                    )
                    Text(
                        if (capText.isBlank()) "Buy size uses the position cap" else "Buy size starts at the cap $$capText",
                        color = Dim,
                        fontSize = 12.sp
                    )
                }
                Button(
                    onClick = { toggleTape() },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (tapePaused) Lime else Color(0xFF1C2416),
                        contentColor = if (tapePaused) Night else Lime
                    )
                ) { Text(if (tapePaused) "Live" else "Pause") }
            }
            Button(
                onClick = {
                    sizeError = null
                    sizeText = capText
                    askBuy = true
                },
                enabled = mintLabel != null,
                modifier = Modifier.padding(top = 8.dp).height(48.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
            ) { Text("Buy", fontSize = 16.sp) }
        }
        // v12.3: one scrollable row of stage chips.
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            stages.forEach { name ->
                FilterChip(selected = stage == name, onClick = { stage = name }, label = { Text(name, fontSize = 13.sp) })
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().nestedScroll(stick),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                itemsIndexed(shown, key = { index, event -> "${event.id}#$index" }) { _, event ->
                    val active = selected?.id == event.id
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(if (active) Color(0xFF1C2416) else Panel, RoundedCornerShape(12.dp))
                            .padding(12.dp)
                    ) {
                        Text("${clock(event.ts)}  ${event.stage.uppercase()}", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                        Text(event.message, color = Ink, fontSize = 13.sp)
                        if (event.mint != null) {
                            TextButton(onClick = { selected = event }) {
                                Text(if (active) "Selected" else "Select", color = Lime)
                            }
                        }
                    }
                }
            }
            if (tapePaused) {
                Button(
                    onClick = { toggleTape() },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
                ) { Text(pausedLabel(fresh)) }
            }
        }
    }
    val buyMint = selected?.mint
    if (askBuy && buyMint != null) {
        val symbol = selected?.symbol ?: buyMint.take(4)
        val ban = cooldowns.firstOrNull { it.mint == buyMint }
        AlertDialog(
            onDismissRequest = { askBuy = false },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text(if (ban != null) "Buy $symbol anyway?" else "Buy $symbol?") },
            text = {
                Column {
                    Text("Size starts at the current cap. A larger number is filled at the cap, never above it. No add while this mint is open. Paper fills on the desk. A real swap happens only when the desk is already live.")
                    if (ban != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Mint is banned after a hard stop. Cooldown has about ${ban.minutesLeft} minute(s) left. Auto buys stay blocked.",
                            color = Coral,
                            fontSize = 13.sp
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = sizeText,
                        onValueChange = { sizeText = it.filter { ch -> ch.isDigit() || ch == '.' } },
                        label = { Text("USD size") },
                        placeholder = { Text(if (capText.isBlank()) "Cap" else capText) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        colors = fieldColors()
                    )
                    if (sizeError != null) Text(sizeError ?: "", color = Coral, fontSize = 12.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val raw = sizeText.trim()
                    val size = if (raw.isEmpty()) null else raw.toDoubleOrNull()
                    if (raw.isNotEmpty() && (size == null || size <= 0.0)) {
                        sizeError = "Size must be a positive USD amount, or blank to use the cap."
                        return@TextButton
                    }
                    askBuy = false
                    onBuy(buyMint, size, ban != null)
                }) { Text(if (ban != null) "Buy anyway" else "Buy", color = Lime) }
            },
            dismissButton = {
                TextButton(onClick = { askBuy = false }) { Text("Cancel", color = Dim) }
            }
        )
    }
}

@Composable
private fun LinkScreen(desk: DeskRepository) {
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var useManual by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    val active by desk.activeUrl.collectAsState()
    val source by desk.linkSource.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        val link = desk.currentLink()
        url = link.baseUrl
        token = link.token
        useManual = link.useManual
        loaded = true
    }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Desk link", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        Text(
            "The phone reads the live tunnel from the desk beacon on its own. A new trycloudflare host shows up here without pasting. Hold a URL only when you want to override that.",
            color = Dim,
            fontSize = 13.sp
        )
        Text(
            if (active.isBlank()) "Following the beacon" else "Now · $source · $active",
            color = Lime,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp
        )
        OutlinedTextField(url, { url = it }, label = { Text("Override URL") }, placeholder = { Text("http://192.168.1.242:4721") }, singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        OutlinedTextField(token, { token = it }, label = { Text("Desk token") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Hold this URL instead of the beacon", color = Ink, modifier = Modifier.weight(1f), fontSize = 14.sp)
            Switch(
                checked = useManual,
                onCheckedChange = { useManual = it },
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = Night)
            )
        }
        Button(
            onClick = { if (loaded) scope.launch { desk.saveLink(url, token, useManual) } },
            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
        ) { Text(if (useManual) "Save and hold this URL" else "Save token and follow the beacon") }
    }
}

@Composable
private fun Metric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier.background(Panel, RoundedCornerShape(16.dp)).padding(14.dp)) {
        Text(label.uppercase(), color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 22.sp)
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Lime,
    unfocusedBorderColor = Color(0xFF2A3324),
    focusedTextColor = Ink,
    unfocusedTextColor = Ink,
    cursorColor = Lime
)

private fun stanceColor(stance: String) = when (stance) {
    "sell" -> Coral
    "skip" -> Amber
    "hold" -> Mint
    "near-miss" -> Amber
    else -> Sky
}

private fun stopRoom(pos: PositionRow): Float {
    val span = pos.entryPrice - pos.stopPrice
    if (!span.isFinite() || span <= 0 || !pos.markPrice.isFinite()) return 0f
    return ((pos.markPrice - pos.stopPrice) / span).toFloat().coerceIn(0f, 1f)
}

private fun heldFor(openedAt: Long): String {
    if (openedAt <= 0) return "—"
    val minutes = ((System.currentTimeMillis() - openedAt).coerceAtLeast(0L)) / 60_000
    if (minutes < 60) return "${minutes}m"
    return "${minutes / 60}h ${minutes % 60}m"
}

private fun money(n: Double?): String = formatUsd(n)

private fun num(n: Double, pattern: String): String = if (n.isFinite()) pattern.format(Locale.US, n) else "—"

@Composable
private fun LastCrashCard() {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scroll = rememberScrollState()
    var text by remember { mutableStateOf(CrashLog.read(context)) }
    val crash = text
    if (crash.isNullOrBlank()) return
    Column(Modifier.fillMaxWidth().background(Color(0xFF2A1614), RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("LAST CRASH", color = Coral, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text("Saved on this phone. Copy it, then send it with the next report.", color = Dim, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        Text(
            crash,
            color = Ink,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            modifier = Modifier.fillMaxWidth().height(160.dp).verticalScroll(scroll)
        )
        Row {
            TextButton(onClick = { clipboard.setText(AnnotatedString(crash)) }) { Text("Copy", color = Lime) }
            TextButton(onClick = {
                CrashLog.clear(context)
                text = null
            }) { Text("Dismiss", color = Dim) }
        }
    }
}

private fun px(n: Double): String {
    if (!n.isFinite() || n < 0) return "—"
    if (n == 0.0) return "0"
    if (n >= 1) return "%.4f".format(Locale.US, n)
    if (n >= 0.01) return "%.6f".format(Locale.US, n)
    return "%.8f".format(Locale.US, n)
}

private fun signed(n: Double): String {
    if (!n.isFinite()) return money(0.0)
    val sign = if (n > 0) "+" else if (n < 0) "−" else ""
    return sign + money(kotlin.math.abs(n))
}

private fun pct(n: Double): String {
    if (!n.isFinite()) return "—"
    val sign = if (n > 0) "+" else if (n < 0) "−" else ""
    return sign + "%.2f".format(Locale.US, kotlin.math.abs(n) * 100) + "%"
}

private fun markAge(ms: Long): String = when {
    ms < 1_000 -> "just now"
    ms < 60_000 -> "${ms / 1000}s"
    else -> "${ms / 60_000}m"
}

private fun fmtPx(n: Double): String = when {
    !n.isFinite() -> "—"
    n >= 1 -> "%.4f".format(Locale.US, n)
    n >= 0.01 -> "%.6f".format(Locale.US, n)
    else -> "%.8f".format(Locale.US, n)
}

/** v12.3 compact connection pill: short text plus one-tap fixes instead of a big red error. */
@Composable
private fun ConnectionPill(message: String, canUseLastGood: Boolean, onUseLastGood: () -> Unit, onEditLink: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(Color(0x1FFFC857), RoundedCornerShape(14.dp))
            .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.width(8.dp).height(8.dp).background(Amber, RoundedCornerShape(4.dp)))
        Spacer(Modifier.width(8.dp))
        Text(message, color = Ink, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (canUseLastGood) TextButton(onClick = onUseLastGood) { Text("Use last good", color = Lime, fontSize = 13.sp) }
        TextButton(onClick = onEditLink) { Text("Edit link", color = Sky, fontSize = 13.sp) }
    }
}

@Composable
private fun StatusPill(text: String, tint: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(Color(0x14FFFFFF), RoundedCornerShape(14.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.width(8.dp).height(8.dp).background(tint, RoundedCornerShape(4.dp)))
        Spacer(Modifier.width(8.dp))
        Text(text, color = Ink, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SellButton(label: String, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    androidx.compose.material3.OutlinedButton(
        onClick = onClick,
        modifier = modifier.height(46.dp),
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, tint),
        contentPadding = PaddingValues(horizontal = 4.dp)
    ) { Text(label, color = tint, fontSize = 15.sp, maxLines = 1) }
}

/** v12.3 "Unable to resolve host x.trycloudflare.com" becomes "Can't reach x". */
internal fun shortConnectionError(error: String?, status: String): String {
    val raw = error?.trim().orEmpty()
    if (raw.isEmpty()) return if (status.isBlank()) "Reconnecting to the desk…" else "$status…"
    val host = Regex("""host "?([a-z0-9.-]+)""", RegexOption.IGNORE_CASE).find(raw)?.groupValues?.get(1)
    if (host != null) return "Can't reach ${host.substringBefore(".trycloudflare.com")}"
    if (raw.contains("timeout", ignoreCase = true) || raw.contains("timed out", ignoreCase = true)) return "Desk is slow to answer · retrying"
    return raw.take(90)
}

/** v12.1 Scout status: each source live, backing off with a countdown, down, or off. */
@Composable
private fun ScoutStatusCard(sources: List<FeedSource>) {
    if (sources.isEmpty()) return
    val counting = sources.any { it.state == "backoff" && it.retryAt != null }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(counting) {
        while (counting) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(1_000)
        }
    }
    val live = sources.count { it.state == "live" }
    var open by rememberSaveable { mutableStateOf(false) }
    // Collapsed still lists any source that is not live, so a problem never hides.
    val shown = if (open) sources else sources.filter { it.state == "backoff" || it.state == "down" }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .background(Color(0xFF151A12), RoundedCornerShape(14.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Scout status", color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f))
            Text("$live/${sources.size} live · ${sources.sumOf { it.sightingsPerMin }} coins/min", color = Dim, fontSize = 12.sp)
            Text(if (open) "  ▾" else "  ▸", color = Dim, fontSize = 14.sp)
        }
        shown.forEach { src ->
            val tint = when (src.state) {
                "live" -> Mint
                "backoff" -> Amber
                "down" -> Coral
                else -> Dim
            }
            Row(Modifier.fillMaxWidth().padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(8.dp).height(8.dp).background(tint, RoundedCornerShape(4.dp)))
                Spacer(Modifier.width(8.dp))
                Text(src.label, color = Color.White, fontSize = 12.sp, modifier = Modifier.width(98.dp), maxLines = 1)
                Text(feedSourceStateText(src, now), color = tint, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(feedSourceRateText(src), color = Dim, fontSize = 11.sp, maxLines = 1)
            }
        }
    }
}

private val clockFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

private fun clock(ts: Long): String = if (ts <= 0) "—" else clockFmt.format(Instant.ofEpochMilli(ts))
