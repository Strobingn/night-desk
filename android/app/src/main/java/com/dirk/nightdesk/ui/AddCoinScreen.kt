package com.dirk.nightdesk.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.CoinLookup
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.DeskSnapshot
import com.dirk.nightdesk.formatUsd
import kotlinx.coroutines.launch
import java.util.Locale

private val CHIPS = listOf(10.0, 25.0, 50.0, 100.0, 250.0)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AddCoinScreen(desk: DeskRepository, snap: DeskSnapshot?, prefill: Pair<String, Int>?) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var input by remember { mutableStateOf(prefill?.first.orEmpty()) }
    var looking by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<CoinLookup?>(null) }
    var size by remember { mutableStateOf(0.0) }
    var confirmSize by remember { mutableStateOf(false) }
    var askBuy by remember { mutableStateOf(false) }

    fun lookup(q: String) {
        if (q.isBlank()) {
            result = CoinLookup(ok = false, error = "Paste a Solana mint or a DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX or Solscan link.")
            return
        }
        looking = true
        scope.launch {
            val found = desk.lookupCoin(q)
            looking = false
            result = found
            confirmSize = false
            if (found.ok) {
                val start = snap?.defaultBuyUsd ?: found.positionCapUsd
                size = kotlin.math.floor(start.coerceIn(1.0, found.sliderMaxUsd))
            }
        }
    }

    LaunchedEffect(prefill?.second) {
        val q = prefill?.first
        if (!q.isNullOrBlank()) {
            input = q
            lookup(q)
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("ADD COIN", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 1.4.sp)
            Text("Mint or link from DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX or Solscan. Share a link into Night Desk to land here.", color = Dim, fontSize = 12.sp)
            OutlinedTextField(
                value = input,
                onValueChange = { input = it.trim() },
                singleLine = true,
                label = { Text("Mint or link") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
                colors = addFieldColors()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { lookup(input) },
                    enabled = !looking,
                    colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Night)
                ) { Text(if (looking) "Looking" else "Look up") }
                TextButton(onClick = {
                    val clip = clipboard.getText()?.text.orEmpty().trim()
                    if (clip.isNotBlank()) {
                        input = clip
                        lookup(clip)
                    }
                }) { Text("Paste", color = Sky) }
            }
        }

        val found = result
        if (found != null && !found.ok) {
            Text(found.error ?: "Lookup failed. No buy without a reliable price.", color = Coral, fontSize = 14.sp)
        }
        if (found != null && found.ok) {
            Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(found.symbol, style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
                        Text(found.name, color = Dim, fontSize = 12.sp)
                        Text(found.tag.uppercase(), color = Amber, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    }
                    TextButton(onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(found.dexscreenerUrl))) }
                    }) { Text("DexScreener", color = Sky) }
                }
                StatLine(if (found.priceSource == "jupiter") "Price (Jupiter)" else "Price", "$" + priceText(found.priceUsd))
                StatLine("Liquidity", compact(found.liquidityUsd))
                StatLine("1h volume", compact(found.volume1hUsd))
                StatLine("Mcap", found.marketCapUsd?.let { compact(it) } ?: "—")
                StatLine("Age", ageText(found.ageSeconds))
                StatLine("Analyst", "%.2f vs line %.2f".format(Locale.US, found.analystScore, found.analystLine), if (found.analystPass) Mint else Coral)
                val verdict = when {
                    found.filterPass && found.analystPass -> "Clears every Filter gate and the Analyst line." to Mint
                    found.hardKills.isNotEmpty() -> ("Hard kill: " + found.hardKills.joinToString { it.code } + ". Buy needs Buy anyway.") to Coral
                    else -> "Misses at least one gate. You can still paper-buy it." to Amber
                }
                Text(verdict.first, color = verdict.second, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                found.checks.forEach { check ->
                    Text((if (check.pass) "✓ " else "✕ ") + check.code + "  " + check.message, color = if (check.pass) Dim else Coral, fontSize = 12.sp)
                }
            }

            Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!found.canBuy) {
                    Text(found.buyBlockedReason ?: "Buy is blocked.", color = Amber, fontSize = 13.sp)
                } else {
                    val max = found.sliderMaxUsd
                    val overCap = size > found.positionCapUsd + 0.005
                    val overPool = size > found.poolMaxUsd + 0.005
                    Row(Modifier.fillMaxWidth()) {
                        Text("Paper buy size", color = Ink, modifier = Modifier.weight(1f))
                        Text(formatUsd(size), color = Lime, fontFamily = FontFamily.Monospace)
                    }
                    Slider(
                        value = size.toFloat().coerceIn(1f, max.toFloat().coerceAtLeast(1f)),
                        onValueChange = {
                            size = kotlin.math.round(it.toDouble())
                            confirmSize = false
                        },
                        valueRange = 1f..max.toFloat().coerceAtLeast(1.01f)
                    )
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CHIPS.filter { it <= max }.forEach { amount ->
                            FilterChip(selected = size == amount, onClick = { size = amount; confirmSize = false }, label = { Text("$" + amount.toInt()) })
                        }
                        FilterChip(selected = false, onClick = { size = kotlin.math.floor(found.positionCapUsd.coerceAtLeast(1.0)); confirmSize = false }, label = { Text("Cap " + formatUsd(found.positionCapUsd)) })
                        FilterChip(selected = false, onClick = { size = max; confirmSize = false }, label = { Text("Max " + formatUsd(max)) })
                    }
                    Text(
                        "Cap ${formatUsd(found.positionCapUsd)} · manual max ${formatUsd(found.manualMaxUsd)} with confirm · cash ${formatUsd(found.cashUsd)} · pool takes about ${formatUsd(found.poolMaxUsd)} under the ${"%.1f".format(Locale.US, found.maxEntrySlippage * 100)}% slippage cap.",
                        color = Dim,
                        fontSize = 12.sp
                    )
                    if (overCap) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = confirmSize, onCheckedChange = { confirmSize = it }, colors = CheckboxDefaults.colors(checkedColor = Lime, checkmarkColor = Night))
                            Text("Confirm ${formatUsd(size)}, above the per-position cap. Without this the desk fills at the cap.", color = Amber, fontSize = 12.sp)
                        }
                    }
                    if (overPool) {
                        Text("This pool only takes about ${formatUsd(found.poolMaxUsd)} under the slippage cap and pool-depth check. The desk refuses a bigger fill.", color = Amber, fontSize = 12.sp)
                    }
                    Button(
                        onClick = { askBuy = true },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = if (found.hardKills.isEmpty()) Lime else Coral, contentColor = Night)
                    ) { Text(if (found.hardKills.isEmpty()) "Paper buy ${formatUsd(size)}" else "Buy ${found.symbol} anyway…") }
                }
                TextButton(enabled = !found.watching, onClick = {
                    scope.launch {
                        val notice = desk.watchCoin(found.mint)
                        if (notice.ok) result = found.copy(watching = true)
                    }
                }) { Text(if (found.watching) "Watching" else "Add to watchlist", color = Sky) }
            }
        }

        Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("WATCHLIST", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 1.4.sp)
            val rows = snap?.watchlist.orEmpty()
            if (rows.isEmpty()) {
                Text("Nothing watched. Look a coin up and tap Add to watchlist.", color = Dim, fontSize = 13.sp)
            }
            rows.forEach { row ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(row.symbol, color = Ink, fontWeight = FontWeight.SemiBold)
                            Text("${row.platform} · added at $${priceText(row.addedPriceUsd)}", color = Dim, fontSize = 11.sp)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(row.lastPriceUsd?.let { "$" + priceText(it) } ?: "—", color = Ink, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                            val change = row.changePct
                            Text(
                                if (change == null) "—" else (if (change >= 0) "+" else "−") + "%.2f%%".format(Locale.US, kotlin.math.abs(change * 100)),
                                color = if (change == null) Dim else if (change >= 0) Mint else Coral,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp
                            )
                        }
                    }
                    Row {
                        TextButton(onClick = {
                            input = row.mint
                            lookup(row.mint)
                        }) { Text("Buy", color = Lime) }
                        TextButton(onClick = {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(row.dexscreenerUrl))) }
                        }) { Text("Chart", color = Sky) }
                        TextButton(onClick = { scope.launch { desk.unwatchCoin(row.mint) } }) { Text("Remove", color = Dim) }
                    }
                }
            }
        }
    }

    val pending = result
    if (askBuy && pending != null && pending.ok) {
        val overCap = size > pending.positionCapUsd + 0.005
        val hard = pending.hardKills.isNotEmpty()
        AlertDialog(
            onDismissRequest = { askBuy = false },
            containerColor = Panel,
            titleContentColor = Ink,
            textContentColor = Ink,
            title = { Text(if (hard) "Buy ${pending.symbol} anyway?" else "Buy ${pending.symbol}?") },
            text = {
                Text(
                    (if (hard) pending.hardKills.joinToString(" ") { it.code + ": " + it.message } + "\n\n" else "") +
                        "Size ${formatUsd(size)}." + (if (overCap && !confirmSize) " Above the cap, so it fills at ${formatUsd(pending.positionCapUsd)}." else "") +
                        " Paper fill only. This does not turn on live trading. The hard stop applies."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    askBuy = false
                    scope.launch {
                        val notice = desk.buyPosition(
                            pending.mint,
                            size,
                            ignoreCooldown = false,
                            confirmHardKill = hard,
                            confirmSize = overCap && confirmSize,
                            symbol = pending.symbol
                        )
                        if (notice.ok) result = pending.copy(held = true, canBuy = false, buyBlockedReason = "Bought. No add while that mint is open.")
                    }
                }) { Text(if (hard) "Buy anyway" else "Buy", color = if (hard) Coral else Lime) }
            },
            dismissButton = { TextButton(onClick = { askBuy = false }) { Text("Cancel", color = Dim) } }
        )
    }
}

@Composable
private fun StatLine(label: String, value: String, tint: androidx.compose.ui.graphics.Color = Ink) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, color = Dim, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(value, color = tint, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
    }
}

@Composable
private fun addFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Lime,
    unfocusedBorderColor = Dim,
    focusedTextColor = Ink,
    unfocusedTextColor = Ink,
    focusedLabelColor = Lime,
    unfocusedLabelColor = Dim
)

internal fun priceText(n: Double): String = when {
    !n.isFinite() || n <= 0 -> "—"
    n >= 1 -> "%.4f".format(Locale.US, n)
    n >= 0.01 -> "%.6f".format(Locale.US, n)
    else -> "%.4g".format(Locale.US, n)
}

internal fun compact(n: Double): String = when {
    !n.isFinite() -> "—"
    kotlin.math.abs(n) >= 1e9 -> "$" + "%.2fB".format(Locale.US, n / 1e9)
    kotlin.math.abs(n) >= 1e6 -> "$" + "%.2fM".format(Locale.US, n / 1e6)
    kotlin.math.abs(n) >= 1e3 -> "$" + "%.1fK".format(Locale.US, n / 1e3)
    else -> formatUsd(n)
}

internal fun ageText(seconds: Double): String = when {
    !seconds.isFinite() || seconds < 0 -> "—"
    seconds < 3600 -> "${(seconds / 60).toInt()}m"
    seconds < 86_400 -> "%.1fh".format(Locale.US, seconds / 3600)
    else -> "%.1fd".format(Locale.US, seconds / 86_400)
}
