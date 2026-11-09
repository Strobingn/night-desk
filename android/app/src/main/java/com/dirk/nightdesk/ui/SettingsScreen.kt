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
import androidx.compose.material3.SliderDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
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
    /** v13.1 volume boost, percent 0–100. */
    val boost: Float,
    val top10: Float,
    val position: Float,
    val slip: Float,
    /** v13.3 exit slippage %, and whether it is set (off = entry cap + 3%). */
    val exitSlip: Float,
    val useExitSlip: Boolean,
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
    val pumpApi: Boolean,
    val launchLab: Boolean,
    val bitquery: Boolean,
    val near: Boolean,
    val fills: Boolean,
    val stops: Boolean,
    val alert: Float,
    val sizeUsd: Float,
    val useSizeUsd: Boolean,
    val exposure: Float,
    val resetUsd: Float,
    /** v13.2 Position price refresh, seconds 1–10. */
    val refresh: Float,
    /** v13.5 live wallet: $ per trade, optional daily cap, trailing stop %. */
    val liveUsd: Float = 5f,
    val liveCap: Float = 50f,
    val useLiveCap: Boolean = false,
    val liveTrail: Float = 1f,
    /** v13.7 AI auto-buys go live too. Off = Live: manual only · AI: paper. */
    val liveAutoBuy: Boolean = false
)

private fun draftOf(snap: DeskSnapshot?): Draft {
    val buy = snap?.defaultBuyUsd
    return Draft(
        volume = (snap?.minVolume1hUsd ?: 10_000.0).toFloat(),
        score = (snap?.analystMinScore ?: 0.5).toFloat(),
        boost = ((snap?.volumeBoost ?: 0.5) * 100.0).toFloat().coerceIn(0f, 100f),
        top10 = ((snap?.maxTop10Pct ?: 0.35) * 100.0).toFloat(),
        position = ((snap?.maxPositionPct ?: 0.08) * 100.0).toFloat(),
        slip = ((snap?.maxEntrySlippage ?: 0.03) * 100.0).toFloat(),
        exitSlip = (((snap?.maxExitSlippage ?: ((snap?.maxEntrySlippage ?: 0.03) + 0.03)) * 100.0).toFloat()).coerceIn(0.5f, 50f),
        useExitSlip = snap?.maxExitSlippage != null,
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
        pumpApi = snap?.scoutPumpApi != false,
        launchLab = snap?.scoutLaunchLab != false,
        bitquery = snap?.scoutBitquery != false,
        near = snap?.notifyNearMiss != false,
        fills = snap?.notifyFills != false,
        stops = snap?.notifyStops != false,
        alert = (snap?.pnlAlertPct ?: 0.0).toFloat(),
        sizeUsd = (snap?.positionSizeUsd ?: snap?.positionCapUsd ?: 8.0).toFloat().coerceIn(1f, 10_000f),
        useSizeUsd = snap?.positionSizeUsd != null,
        exposure = ((snap?.maxExposurePct ?: 1.0) * 100.0).toFloat().coerceIn(10f, 100f),
        resetUsd = (snap?.paperResetUsd ?: 100.0).toFloat().coerceIn(100f, 10_000f),
        refresh = ((snap?.positionRefreshMs ?: 1_500L) / 1_000.0).toFloat().coerceIn(1f, 10f),
        liveUsd = (snap?.liveTradeUsd ?: 5.0).toFloat().coerceIn(1f, 100f),
        liveCap = (snap?.liveDailyCapUsd ?: 50.0).toFloat().coerceIn(5f, 100_000f),
        useLiveCap = snap?.liveDailyCapUsd != null,
        liveTrail = ((snap?.liveTrailPct ?: 0.01) * 100.0).toFloat().coerceIn(0.5f, 20f),
        liveAutoBuy = snap?.liveAutoBuy == true
    )
}

@Composable
fun SettingsScreen(snap: DeskSnapshot?, oneTap: OneTapUi? = null, onSave: (Map<String, Any?>) -> Unit) {
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
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Chip(
                if (dirty) "Unsaved changes" else "Matches the desk",
                if (dirty) P.amber else P.up,
                (if (dirty) P.amber else P.up).copy(alpha = 0.16f),
                size = 12
            )
        }
        AppearanceGroup()
        if (oneTap != null) {
            Group("One tap") {
                Text(
                    "Size and slippage for the Buy and Sell buttons on Home, Tape and Add coin. Sell all stays here.",
                    color = Dim,
                    fontSize = 12.sp
                )
                // Slippage joins the draft. Saving it immediately left draft.slip on the old
                // value, and a later Save of any dirty draft wrote that old cap back.
                OneTapBar(
                    oneTap,
                    slipPct = draft.slip.toDouble(),
                    onSlip = { pct -> draft = draft.copy(slip = oneTapSlipPct(pct).toFloat()) },
                )
            }
        }
        Group("Live wallet") {
            WalletCard(snap)
            var showReady by remember { mutableStateOf(false) }
            TextButton(onClick = { showReady = !showReady }) { Text(if (showReady) "Hide" else "Details", color = P.accent) }
            if (showReady) {
                val lines = snap?.readiness?.lines.orEmpty()
                if (lines.isEmpty()) Text("Waiting for the desk checklist.", color = Dim, fontSize = 12.sp)
                lines.forEach { line -> Text(line, color = P.ink, fontSize = 12.sp) }
                Text(
                    "This note does not enable live trading and does not save a seed or private key. The wallet key lives only in WALLET_PRIVATE_KEY on the desk host. Night Desk has no wallet vault.",
                    color = Dim,
                    fontSize = 12.sp
                )
            }
            Text(
                "AI auto-buys stay on the paper book. The server refuses a request to send them live. Your live buys, sells, limits and stops default to \$5. These limits are not a tested profit system.",
                color = P.ink,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold
            )
            ExactSlider("Live $ per trade", draft.liveUsd, 1f..100f, 1f, { "%.0f".format(it) }) { draft = draft.copy(liveUsd = it) }
            Text("Up to \$100. Every live buy spends exactly this much USDC (\$5 default). Paper sizes are never used live.", color = Dim, fontSize = 12.sp)
            ToggleRow("Live daily cap", draft.useLiveCap) { draft = draft.copy(useLiveCap = it) }
            if (draft.useLiveCap) {
                ExactSlider("Live daily cap $", draft.liveCap, 5f..1_000f, 5f, { "%.0f".format(it) }) { draft = draft.copy(liveCap = it) }
            }
            Text("Off by default: no max per day.", color = Dim, fontSize = 12.sp)
            ExactSlider("Live trailing stop %", draft.liveTrail, 0.5f..20f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(liveTrail = it) }
            Text("Armed from entry. Sells when an accepted mark falls this far below the highest mark since the buy (1% default). The −6% hard stop still fires first.", color = Dim, fontSize = 12.sp)
        }
        Group("Entry / Filter") {
            ExactSlider("1h volume $", draft.volume, 1_000f..500_000f, 1000f, { "%.0f".format(it) }) { draft = draft.copy(volume = it) }
            ExactSlider("Trade line", draft.score, 0.10f..0.95f, 0.01f, { "%.2f".format(it) }) { draft = draft.copy(score = it) }
            ExactSlider("Volume boost %", draft.boost, 0f..100f, 5f, { "%.0f".format(it) }) { draft = draft.copy(boost = it) }
            Text("High 1h volume adds to the Analyst score: none at \$10k, half at \$100k, full at \$1M+. 50% = up to +0.10. 0 = off. Never lowers a score or passes 1. No volume data = no boost.", color = Dim, fontSize = 12.sp)
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
            ExactSlider("Trail arm %", draft.arm, 12f..600f, 1f, { "%.0f".format(it) }) { draft = draft.copy(arm = it.coerceAtLeast(12f)) }
            ExactSlider("Trail gap %", draft.gap, 0.5f..4f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(gap = it.coerceAtMost(4f)) }
            ToggleRow("Trailing take profit", draft.trail) { draft = draft.copy(trail = it) }
            Text("Off by default. Winners stay until you sell. Arm cannot be easier than 12%. Gap cannot be wider than 4%.", color = Dim, fontSize = 12.sp)
        }
        Group("Sizing") {
            ExactSlider("Max position % of book", draft.position, 1f..50f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(position = it) }
            Text("Cap for auto buys and normal manual buys. A confirmed manual buy on Add coin may go up to 100%.", color = Dim, fontSize = 12.sp)
            ToggleRow("Fixed $ per auto buy", draft.useSizeUsd) { draft = draft.copy(useSizeUsd = it) }
            if (draft.useSizeUsd) {
                ExactSlider("Position size $", draft.sizeUsd, 1f..10_000f, 1f, { "%.0f".format(it) }) { draft = draft.copy(sizeUsd = it) }
            }
            ExactSlider("Max total exposure %", draft.exposure, 10f..100f, 5f, { "%.0f".format(it) }) { draft = draft.copy(exposure = it) }
            Text("Open positions as a share of equity. 100% = only cash limits it.", color = Dim, fontSize = 12.sp)
            ExactSlider("Entry slippage %", draft.slip, 0.5f..50f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(slip = it) }
            Text("Max price impact a buy may pay, 0.5–50% (3% default). A buy past it is refused, never filled worse; the fill is recorded at its real price. The −6% stop is unchanged.", color = Dim, fontSize = 12.sp)
            ToggleRow("Custom exit slippage", draft.useExitSlip) { draft = draft.copy(useExitSlip = it) }
            if (draft.useExitSlip) {
                ExactSlider("Exit slippage %", draft.exitSlip, 0.5f..50f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(exitSlip = it) }
            }
            Text("Max cost of selling the whole position, checked before every buy. Off = entry cap + 3%. Sells always go through at the real fill.", color = Dim, fontSize = 12.sp)
            ExactSlider("Manual buy $", draft.buy, 1f..10_000f, 1f, { "%.0f".format(it) }) { draft = draft.copy(buy = it, useCap = false) }
            ToggleRow("Use the position cap instead", draft.useCap) { draft = draft.copy(useCap = it) }
            ExactSlider("Max open", draft.open, 1f..24f, 1f, { "%.0f".format(it) }) { draft = draft.copy(open = it) }
            ExactSlider("Position price refresh s", draft.refresh, 1f..10f, 0.5f, { "%.1f".format(it) }) { draft = draft.copy(refresh = it) }
            Text("How often open positions are re-priced. Pool reserves every cycle; DexScreener every 3 s and Jupiter every 5 s at most, so the Scout is not rate-limited.", color = Dim, fontSize = 12.sp)
            ExactSlider("Max trades / hour", draft.rate, 0f..60f, 1f, { "%.0f".format(it) }) { draft = draft.copy(rate = it) }
            ToggleRow("Auto-buy", draft.autoBuy) { draft = draft.copy(autoBuy = it) }
            Text("0 trades per hour means no hourly cap. Auto-buy off still leaves manual Buy and Buy anyway.", color = Dim, fontSize = 12.sp)
            ExactSlider("Paper reset amount $", draft.resetUsd, 100f..10_000f, 100f, { "%.0f".format(it) }) { draft = draft.copy(resetUsd = it) }
            Text("Slippage and the pool-depth exit check still cap every size. A bigger ask than the pool takes is refused.", color = Dim, fontSize = 12.sp)
        }
        Group("Scout sources") {
            ToggleRow("Pump", true) {}
            Text("Pump stays on. It is the primary feed.", color = Dim, fontSize = 12.sp)
            ToggleRow("Pump.fun API", draft.pumpApi) { draft = draft.copy(pumpApi = it) }
            ToggleRow("Bonk.fun / LaunchLab", draft.launchLab) { draft = draft.copy(launchLab = it) }
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
                    onSave(changedOnly(payload(saved), payload(draft)))
                    saved = draft
                },
                enabled = dirty && snap != null,
                colors = ButtonDefaults.buttonColors(containerColor = P.accent, contentColor = P.onAccent)
            ) { Text("Save") }
            TextButton(onClick = { draft = saved }, enabled = dirty) { Text("Reset", color = Dim) }
        }
    }
}

/** Only the keys Dirk changed are sent, so a save never rewrites a value he did not touch. */
internal fun changedOnly(before: Map<String, Any?>, after: Map<String, Any?>): Map<String, Any?> =
    after.filter { (key, value) -> before[key] != value }

/** Same 0.5% steps as the one-tap slip control. */
internal fun oneTapSlipPct(raw: Double): Double =
    (kotlin.math.round(raw * 2.0) / 2.0).coerceIn(0.5, 50.0)

/**
 * Settings one-tap slippage edits the draft. The Save that follows sends that slip,
 * not the cap that was on the draft before the tap.
 */
internal fun settingsPatchAfterOneTap(
    saved: Map<String, Any?>,
    draft: Map<String, Any?>,
    oneTapRaw: Double,
): Map<String, Any?> = changedOnly(saved, draft + ("maxEntrySlippage" to oneTapSlipPct(oneTapRaw)))

private fun payload(draft: Draft): Map<String, Any?> = mapOf(
    "minVolume1hUsd" to draft.volume.toDouble(),
    "analystMinScore" to draft.score.toDouble(),
    "volumeBoost" to Math.round(draft.boost.toDouble()) / 100.0,
    "maxTop10Pct" to draft.top10.toDouble(),
    "maxPositionPct" to draft.position.toDouble(),
    "maxEntrySlippage" to draft.slip.toDouble(),
    "maxExitSlippage" to if (draft.useExitSlip) draft.exitSlip.toDouble() else null,
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
    "scoutPumpApi" to draft.pumpApi,
    "scoutLaunchLab" to draft.launchLab,
    "scoutBitquery" to draft.bitquery,
    "notifyNearMiss" to draft.near,
    "notifyFills" to draft.fills,
    "notifyStops" to draft.stops,
    "pnlAlertPct" to draft.alert.toDouble(),
    "positionSizeUsd" to if (draft.useSizeUsd) draft.sizeUsd.toDouble() else null,
    "maxExposurePct" to draft.exposure.toDouble(),
    "paperResetUsd" to draft.resetUsd.toDouble(),
    "positionRefreshMs" to Math.round(draft.refresh.toDouble() * 1_000.0),
    "liveTradeUsd" to draft.liveUsd.toDouble(),
    "liveDailyCapUsd" to if (draft.useLiveCap) draft.liveCap.toDouble() else null,
    "liveTrailPct" to Math.round(draft.liveTrail.toDouble() * 10.0) / 10.0
)

/** v13 group icons and one-line descriptions, same as the web. */
private val GROUP_META = mapOf(
    Pair("Live wallet", Pair("shield", "Real-money settings. Used only when the desk host runs with LIVE_TRADING=true.")),
    Pair("Entry / Filter", Pair("filter", "What a new coin must pass, and how the Analyst scores it.")),
    Pair("Risk / Exits", Pair("shield", "Hard stop, cooldown, daily loss and the trailing take-profit.")),
    Pair("Sizing", Pair("coins", "How much each buy spends and how much can be open at once.")),
    Pair("Scout sources", Pair("radar", "Which feeds the Scout listens to for new pairs.")),
    Pair("Alerts", Pair("bell", "When the phone should ping you."))
)

@Composable
private fun Group(title: String, body: @Composable () -> Unit) {
    val meta = GROUP_META[title]
    Column(Modifier.deskCard().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GroupHeader(meta?.first ?: "settings", title, meta?.second ?: "")
        body()
    }
}

/** v13 Appearance. A phone-only preference: saved on this device, never sent to the desk. */
@Composable
private fun AppearanceGroup() {
    val context = LocalContext.current
    Column(Modifier.deskCard().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GroupHeader("palette", "Appearance", "Theme for this phone only. Not a desk setting.")
        SegmentedFill(
            ThemePref.entries.map { it.name to it.label },
            ThemeState.pref.name,
            mapOf(Pair("DARK", "moon"), Pair("LIGHT", "sun"), Pair("SYSTEM", "auto"))
        ) { ThemeState.set(context, ThemePref.valueOf(it)) }
        Text(
            if (ThemeState.pref == ThemePref.SYSTEM) "Following the phone: ${if (P.isDark) "dark" else "light"} right now." else "Dark is the default. System follows the phone.",
            color = P.muted,
            fontSize = 12.sp
        )
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
            Text(format(value), color = P.accent, fontFamily = FontFamily.Monospace, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
        Slider(
            value = value.coerceIn(range.start, range.endInclusive),
            onValueChange = {
                val snapped = range.start + kotlin.math.round((it - range.start) / step) * step
                onChange(snapped.coerceIn(range.start, range.endInclusive))
            },
            valueRange = range,
            steps = steps,
            colors = SliderDefaults.colors(
                thumbColor = P.accent,
                activeTrackColor = P.accent,
                inactiveTrackColor = P.card3,
                activeTickColor = Color.Transparent,
                inactiveTickColor = Color.Transparent
            )
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
            colors = SwitchDefaults.colors(
                checkedTrackColor = P.accent,
                checkedThumbColor = P.onAccent,
                uncheckedTrackColor = P.card3,
                uncheckedThumbColor = P.muted,
                uncheckedBorderColor = P.lineStrong
            )
        )
    }
}
