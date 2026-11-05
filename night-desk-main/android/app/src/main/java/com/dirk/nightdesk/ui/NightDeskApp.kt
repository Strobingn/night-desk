package com.dirk.nightdesk.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.AdviceNote
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.DeskSnapshot
import com.dirk.nightdesk.PositionRow
import com.dirk.nightdesk.TapeEvent
import kotlinx.coroutines.launch
import java.text.NumberFormat
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
    var tab by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        val link = desk.currentLink()
        if (link.baseUrl.isNotBlank()) desk.start(link.baseUrl, link.token) else tab = 2
    }

    Scaffold(
        containerColor = Night,
        bottomBar = {
            NavigationBar(containerColor = Color(0xFF10140E)) {
                listOf("Book", "Tape", "Link").forEachIndexed { index, label ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        label = { Text(label) },
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
            if (!error.isNullOrBlank()) {
                Text(error ?: "", color = Coral, modifier = Modifier.padding(horizontal = 20.dp), fontSize = 12.sp)
            }
            when (tab) {
                0 -> BookScreen(
                    snap,
                    onClose = { mint -> scope.launch { desk.closePosition(mint) } },
                    onVolume = { usd -> scope.launch { desk.setMinVolume(usd) } },
                    onReset = { scope.launch { desk.resetPaperBook() } }
                )
                1 -> TapeScreen(snap?.events.orEmpty())
                else -> LinkScreen(desk)
            }
        }
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
    onVolume: (Double) -> Unit,
    onReset: () -> Unit
) {
    LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
        if (snap?.mode != "live") {
            item { ResetCard(onReset) }
        }
        item { AdvisorCard(snap?.advice.orEmpty()) }
        item { VolumeCard(snap?.minVolume1hUsd ?: 50_000.0, onVolume) }
        item { Text("Open", style = androidx.compose.material3.MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp)) }
        if (snap == null || snap.positions.isEmpty()) {
            item { Text("Flat. A name still has to clear every hard filter.", color = Dim, modifier = Modifier.padding(bottom = 24.dp)) }
        } else {
            items(snap.positions, key = { it.mint }) { pos -> PositionCard(pos, onClose) }
        }
    }
}

@Composable
private fun AdvisorCard(notes: List<AdviceNote>) {
    Column(Modifier.fillMaxWidth().background(Color(0xFF171E12), RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("ADVISOR", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text("Follows the feed. Does not trade.", color = Dim, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        if (notes.isEmpty()) {
            Text("Waiting for the next mark.", color = Ink)
        } else {
            notes.forEach { note ->
                Row(Modifier.padding(vertical = 6.dp)) {
                    Text(note.stance.uppercase(), color = stanceColor(note.stance), fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.width(52.dp))
                    Text(note.text, color = Ink, fontSize = 14.sp, lineHeight = 19.sp)
                }
            }
        }
    }
}

@Composable
private fun ResetCard(onReset: () -> Unit) {
    var ask by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("PAPER BOOK", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text("Reset drops open positions and starts cash at $100.", color = Ink, fontSize = 13.sp)
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
                Text("Open positions are dropped and session PnL starts over at $100. No order is sent. The log, advisor memory, and volume floor stay. Live trading stays off.")
            },
            confirmButton = {
                TextButton(onClick = {
                    ask = false
                    onReset()
                }) { Text("Reset to $100", color = Amber) }
            },
            dismissButton = {
                TextButton(onClick = { ask = false }) { Text("Keep book", color = Lime) }
            }
        )
    }
}

@Composable
private fun VolumeCard(current: Double, onVolume: (Double) -> Unit) {
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
            Button(onClick = { text.toDoubleOrNull()?.let(onVolume) }, colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)) {
                Text("Apply")
            }
        }
        Text("$1,000–$500,000. Default $50,000 until you change it.", color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
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
        Text("${pct(pos.pnlPct)}  ·  score ${"%.2f".format(pos.score)}", color = Dim, fontSize = 12.sp)
        Text("Hard stop ${fmtPx(pos.stopPrice)}  ·  ${"%.1f".format(pos.stopDistancePct)}% under the mark", color = Ink, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
        val context = LocalContext.current
        FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            chartLinks(pos.mint).forEach { (label, url) ->
                TextButton(onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                }) { Text(label, color = Sky) }
            }
        }
        TextButton(onClick = { onClose(pos.mint) }) { Text("Close", color = Coral) }
    }
}

/** Look-only feeds. Opening one does not send a desk order. */
private fun chartLinks(mint: String): List<Pair<String, String>> = listOf(
    "Chart" to "https://dexscreener.com/solana/$mint",
    "Birdeye" to "https://birdeye.so/token/$mint?chain=solana",
    "Jupiter" to "https://jup.ag/tokens/$mint"
)

@Composable
private fun TapeScreen(events: List<TapeEvent>) {
    var stage by remember { mutableStateOf("all") }
    val shown = events.filter { stage == "all" || it.stage == stage }.asReversed()
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            stages.take(4).forEach { name ->
                FilterChip(selected = stage == name, onClick = { stage = name }, label = { Text(name) })
            }
        }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            stages.drop(4).forEach { name ->
                FilterChip(selected = stage == name, onClick = { stage = name }, label = { Text(name) })
            }
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(shown, key = { it.id }) { event ->
                Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(12.dp)).padding(12.dp)) {
                    Text("${clock(event.ts)}  ${event.stage.uppercase()}", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    Text(event.message, color = Ink, fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun LinkScreen(desk: DeskRepository) {
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        val link = desk.currentLink()
        url = link.baseUrl
        token = link.token
        loaded = true
    }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Desk link", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        Text("Austin on the same Wi‑Fi, or the cloudflared / ngrok HTTPS URL. The token stays on this phone.", color = Dim, fontSize = 13.sp)
        OutlinedTextField(url, { url = it }, label = { Text("Base URL") }, placeholder = { Text("http://192.168.1.20:4721") }, singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        OutlinedTextField(token, { token = it }, label = { Text("Desk token") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        Button(
            onClick = { if (loaded) scope.launch { desk.saveLink(url, token) } },
            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
        ) { Text("Save and follow the feed") }
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
    else -> Sky
}

private fun money(n: Double?): String = NumberFormat.getCurrencyInstance(Locale.US).format(n ?: 0.0)

private fun signed(n: Double): String {
    val sign = if (n > 0) "+" else if (n < 0) "−" else ""
    return sign + money(kotlin.math.abs(n))
}

private fun pct(n: Double): String {
    val sign = if (n > 0) "+" else if (n < 0) "−" else ""
    return sign + "%.2f".format(kotlin.math.abs(n) * 100) + "%"
}

private fun fmtPx(n: Double): String = when {
    n >= 1 -> "%.4f".format(n)
    n >= 0.01 -> "%.6f".format(n)
    else -> "%.8f".format(n)
}

private val clockFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

private fun clock(ts: Long): String = if (ts <= 0) "—" else clockFmt.format(Instant.ofEpochMilli(ts))
