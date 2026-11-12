package com.dirk.nightdesk.ui

import android.content.Intent
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import com.dirk.nightdesk.CoinCard
import com.dirk.nightdesk.Verdict
import com.dirk.nightdesk.coinCards
import com.dirk.nightdesk.sortCoins
import com.dirk.nightdesk.TapeSort
import com.dirk.nightdesk.TOP_VOLUME
import com.dirk.nightdesk.HOT_RANK
import android.net.Uri
import androidx.compose.foundation.Canvas
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import com.dirk.nightdesk.BuildConfig
import com.dirk.nightdesk.CrashLog
import com.dirk.nightdesk.showDeskCrash
import com.dirk.nightdesk.showPhoneCrash
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.formatUsd
import com.dirk.nightdesk.DeskSnapshot
import com.dirk.nightdesk.LiveBookInfo
import com.dirk.nightdesk.LiveReadiness
import com.dirk.nightdesk.MintCooldown
import com.dirk.nightdesk.PositionRow
import com.dirk.nightdesk.PricePoint
import com.dirk.nightdesk.TapeEvent
import com.dirk.nightdesk.TapeFollowInput
import com.dirk.nightdesk.TapeFollowState
import com.dirk.nightdesk.countNewSince
import com.dirk.nightdesk.pausedLabel
import com.dirk.nightdesk.stepTapeFollow
import com.dirk.nightdesk.chartLinks
import com.dirk.nightdesk.liveAgeMs
import com.dirk.nightdesk.markFreshness
import com.dirk.nightdesk.MarkFreshness
import com.dirk.nightdesk.updatedLabel
import com.dirk.nightdesk.feedLabel
import com.dirk.nightdesk.pump.PumpScreen
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** v13 bottom nav: label to icon. Link stays as the sixth tab. */
/** v13.32 five tabs. Recap, Link and Pump live under Settings → More. */
private val NAV_TABS = listOf("Home" to "home", "Tape" to "tape", "Search" to "search", "Engine" to "radar", "Settings" to "settings")
internal const val TAB_HOME = 0
internal const val TAB_TAPE = 1
internal const val TAB_SEARCH = 2
internal const val TAB_ENGINE = 3
internal const val TAB_SETTINGS = 4

private fun stageColor(stage: String): Color = when (stage) {
    "filter" -> P.down
    "executor" -> P.up
    "risk" -> P.amber
    "analyst" -> P.accent
    "scout" -> P.ink
    else -> P.muted
}

@Composable
private fun CoinCardRow(coin: CoinCard, selected: Boolean, onSelect: () -> Unit, onBuy: () -> Unit, oneTap: OneTapUi? = null, orders: OrderActions? = null, safety: String = "", bundle: String = "") {
    // v13.11 limit buy ticket on this card.
    var limitOpen by remember(coin.mint) { mutableStateOf(orders?.openFor?.let { it.first == coin.mint && it.second == "limit_buy" } == true) }
    var liveOrderOpen by remember(coin.mint) { mutableStateOf(false) }
    // v13.32 the LIVE strip is folded away by default; a held live position opens it.
    var liveOpen by remember(coin.mint) { mutableStateOf(oneTap?.liveHeld?.containsKey(coin.mint) == true) }
    // v13.4 compact card: same facts and buttons as v13.1, packed into three rows so 4-5 cards fit
    // on one phone screen. Symbol, 1h change and volume stay large; nothing was dropped.
    val vc = verdictColor(coin.verdict)
    val rank = coin.volRank
    val top = rank != null && rank <= TOP_VOLUME
    val hot = rank != null && rank <= HOT_RANK
    val borderColor = when {
        selected -> P.accent
        hot -> P.amber.copy(alpha = 0.75f)
        top -> P.accent.copy(alpha = 0.45f)
        else -> P.line
    }
    val ch = coin.change1h?.takeIf { it.isFinite() }
    val chTint = when {
        ch == null -> P.ink
        ch > 0 -> P.up
        ch < 0 -> P.down
        else -> P.ink
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(P.card)
            .border(if (selected) 2.dp else 1.dp, borderColor, RoundedCornerShape(16.dp))
            .clickable(onClick = onSelect)
            .padding(start = 12.dp, end = 12.dp, top = 9.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CoinAvatar(coin.symbol, coin.mint, ring = vc, size = 36.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // Symbol is measured first so the chips never squeeze it away.
                    Text(coin.symbol, color = P.ink, fontSize = 19.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 150.dp))
                    Spacer(Modifier.width(6.dp))
                    Row(Modifier.weight(1f, fill = false).clipToBounds(), verticalAlignment = Alignment.CenterVertically) {
                        Chip(coin.verdict.label, vc, vc.copy(alpha = 0.18f), size = 11)
                        if (hot) {
                            Spacer(Modifier.width(4.dp))
                            Chip("HOT #$rank", if (P.isDark) Color(0xFF1A1000) else Color.White, if (P.isDark) P.amber else Color(0xFFB86E00), size = 11)
                        } else if (top) {
                            Spacer(Modifier.width(4.dp))
                            Chip("VOL #$rank", P.accent, P.accent.copy(alpha = 0.2f), size = 11)
                        }
                        if (!coin.unenriched.isNullOrBlank()) {
                            Spacer(Modifier.width(4.dp))
                            Chip("not enriched", P.amber, P.amber.copy(alpha = 0.16f), bold = false, size = 10)
                        }
                        if (safety.isNotBlank()) {
                            Spacer(Modifier.width(4.dp))
                            Chip(safety, if (safety.startsWith("Blocked")) P.down else P.dim, P.card3, bold = false, size = 10)
                        }
                        if (bundle.isNotBlank()) {
                            Spacer(Modifier.width(4.dp))
                            Chip(bundle, P.amber, P.amber.copy(alpha = 0.16f), bold = false, size = 10)
                        }
                    }
                }
                val sc = coin.score
                val pass = coin.verdict == Verdict.TRADE || coin.verdict == Verdict.BOUGHT || coin.verdict == Verdict.OPEN
                Text(
                    "${coin.source ?: "scout"} · ${clock(if (coin.lastTs > 0) coin.lastTs else System.currentTimeMillis())}" +
                        (if (sc != null) " · score " + "%.2f".format(Locale.US, sc) else ""),
                    color = if (sc != null && pass) P.up else P.dim,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    if (ch == null) com.dirk.nightdesk.tapeMissing(coin, "chg") else (if (ch > 0) "+" else if (ch < 0) "−" else "") + "%.1f%%".format(Locale.US, kotlin.math.abs(ch)),
                    color = if (ch == null) P.muted else chTint,
                    fontSize = if (ch == null) 12.sp else 19.sp,
                    fontWeight = FontWeight.Black,
                    maxLines = 1
                )
                Text("1H CHG", color = P.dim, fontSize = 10.5.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            }
        }
        // 1h volume, 5m volume and price on one line, label then value.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            // v13.10: live values from the desk's Tape quotes; a short reason instead of a bare dash.
            TapeInline("1H VOL", coin.vol1h?.let { compact(it) } ?: com.dirk.nightdesk.tapeMissing(coin, "vol"), Modifier.weight(1f), big = true, why = coin.vol1h == null)
            TapeInline("5M VOL", coin.vol5m?.let { compact(it) } ?: com.dirk.nightdesk.tapeMissing(coin, "vol"), Modifier.weight(0.9f), why = coin.vol5m == null)
            TapeInline("PRICE", coin.mark?.let { com.dirk.nightdesk.TapeToolbar.shortPrice(it) } ?: com.dirk.nightdesk.tapeMissing(coin, "price"), Modifier.weight(1.2f), why = coin.mark == null)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (coin.reason.isNullOrBlank()) (coin.codes.firstOrNull() ?: "") else (coin.codes.firstOrNull()?.let { "$it · " } ?: "") + coin.reason,
                color = P.dim,
                fontSize = 12.5.sp,
                lineHeight = 15.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 8.dp)
            )
            if (coin.verdict != Verdict.OPEN) {
                if (oneTap != null) {
                    // v13.3: one tap buys now at the one-tap size; "Buy…" keeps the confirm dialog.
                    val inFlight = oneTap.buying(coin.mint)
                    BigButton(if (inFlight) "Buying…" else oneTap.buyLabel, P.up, P.onUp, Modifier.width(if (orders != null) 108.dp else 118.dp), height = 38.dp, enabled = !inFlight) { oneTap.onBuy(coin.mint, coin.symbol) }
                    if (orders != null) {
                        Spacer(Modifier.width(6.dp))
                        BigButton("Limit", if (limitOpen) P.blue else P.card3, if (limitOpen) Color(0xFF001427) else P.blue, Modifier.width(58.dp), border = P.blue.copy(alpha = 0.6f), height = 38.dp) { limitOpen = !limitOpen }
                    }
                    Spacer(Modifier.width(6.dp))
                    BigButton("Buy…", P.card3, P.ink, Modifier.width(60.dp), border = P.lineStrong, height = 38.dp, onClick = onBuy)
                } else {
                    BigButton("Buy", P.up, P.onUp, Modifier.width(104.dp), height = 38.dp, onClick = onBuy)
                }
            } else {
                if (oneTap != null && oneTap.paperHeld.containsKey(coin.mint)) {
                    BookTag(live = false)
                    Spacer(Modifier.width(4.dp))
                    val pp = oneTap.paperHeld[coin.mint]!!
                    Text((if (pp >= 0) "+" else "−") + formatUsd(kotlin.math.abs(pp)), color = if (pp >= 0) P.up else P.down, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                } else Chip("Holding", P.blue, P.blue.copy(alpha = 0.18f), size = 13)
                if (oneTap != null) {
                    Spacer(Modifier.width(6.dp))
                    val inFlight = oneTap.selling(coin.mint)
                    BigButton(if (inFlight) "Selling…" else "⚡ Sell", P.down, P.onDown, Modifier.width(92.dp), height = 38.dp, enabled = !inFlight) { oneTap.onSell(coin.mint, coin.symbol) }
                }
            }
        }
        // LIVE BUY / LIVE SELL, folded behind one line. Paper buttons above stay paper.
        if (oneTap != null) {
            val heldLiveNow = oneTap.liveHeld[coin.mint]
            Row(Modifier.fillMaxWidth().clickable { liveOpen = !liveOpen }.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                BookTag(live = true)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (heldLiveNow != null) "held · " + (if (heldLiveNow.pnlUsd >= 0) "+" else "−") + formatUsd(kotlin.math.abs(heldLiveNow.pnlUsd)) else "real money",
                    color = if (heldLiveNow == null) P.muted else if (heldLiveNow.pnlUsd >= 0) P.up else P.down,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f)
                )
                Text(if (liveOpen) "Hide ▴" else "Show ▾", color = LivePink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            if (liveOpen) LivePair(oneTap, coin.mint, coin.symbol, Modifier.padding(top = 4.dp), compact = true)
            if (orders != null && liveOpen) {
                val heldLive = oneTap.liveHeld.containsKey(coin.mint)
                BigButton(
                    if (heldLive) "LIVE stop" else "LIVE limit",
                    if (liveOrderOpen) LivePink else P.card3,
                    if (liveOrderOpen) Color.White else LivePink,
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    border = LivePink.copy(alpha = 0.7f),
                    height = 36.dp
                ) { liveOrderOpen = !liveOrderOpen }
                if (liveOrderOpen) {
                    val held = oneTap.liveHeld[coin.mint]
                    Box(Modifier.padding(top = 8.dp)) {
                        LiveOrderTicket(orders, coin.mint, coin.symbol, heldLive, coin.mark, held?.entryPrice, held?.stopPrice) { liveOrderOpen = false }
                    }
                }
            }
        }
        if (orders != null) {
            val mine = orders.openOn(coin.mint)
            if (mine.isNotEmpty()) Box(Modifier.padding(top = 6.dp)) { OrderChips(orders, mine) }
            if (limitOpen) Box(Modifier.padding(top = 8.dp)) { LimitBuyTicket(orders, coin.mint, coin.symbol, coin.mark) { limitOpen = false } }
        }
    }
}

@Composable
private fun TapeInline(label: String, value: String, modifier: Modifier, big: Boolean = false, why: Boolean = false) {
    Row(modifier, verticalAlignment = Alignment.Bottom) {
        Text(label, color = P.dim, fontSize = 10.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.3.sp, maxLines = 1, modifier = Modifier.padding(bottom = 2.dp))
        Spacer(Modifier.width(4.dp))
        if (why) Text(value, color = P.muted, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 2.dp))
        else Text(value, color = P.ink, fontSize = if (big) 16.sp else 15.sp, fontWeight = if (big) FontWeight.Black else FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun TapeStat(label: String, value: String, modifier: Modifier, big: Boolean = false, tint: Color = P.ink) {
    Column(modifier.padding(end = 6.dp)) {
        Text(label, color = P.dim, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, maxLines = 1)
        Text(value, color = tint, fontSize = if (big) 22.sp else 16.sp, fontWeight = if (big) FontWeight.Black else FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

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
    // v13.32 Settings hosts Link, Recap and Pump as sub-screens.
    var settingsSub by rememberSaveable { mutableStateOf<String?>(null) }
    var addPrefill by remember { mutableStateOf<Pair<String, Int>?>(null) }
    val scope = rememberCoroutineScope()
    // v13.3 one tap: haptic tick on every one-tap Buy / Sell, one order per tap.
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val tapping by desk.tapping.collectAsState()
    val tapSaved by desk.tapUsd.collectAsState()
    val oneTap = snap?.let { s ->
        // Armed desk: the lightning button stays the paper size. Live size is only the LIVE strip.
        val paperTap = com.dirk.nightdesk.OneTap.defaultTapUsd(tapSaved, s.defaultBuyUsd, s.positionCapUsd)
        val tapNow = if (s.liveBook != null) paperTap else com.dirk.nightdesk.OneTap.effectiveTapUsd(s.mode, paperTap, s.liveTradeUsd)
        OneTapUi(
            tapUsd = tapNow,
            capUsd = s.positionCapUsd,
            capLine = s.capLine,
            maxUsd = kotlin.math.max(s.positionCapUsd, s.cashUsd),
            slipPct = kotlin.math.round(s.maxEntrySlippage * 10_000.0) / 100.0,
            stopPct = s.stopLossPct,
            tapping = tapping,
            openCount = s.positions.size,
            onBuy = { mint, symbol ->
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch {
                    if (s.mode == "live" && s.liveBook == null) desk.liveTapBuy(mint, symbol, s.liveTradeUsd, null)
                    else desk.oneTapBuy(mint, symbol, tapNow)
                }
            },
            onSell = { mint, symbol ->
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch { desk.oneTapSell(mint, symbol) }
            },
            onSellAll = {
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch { desk.sellAll() }
            },
            onTapUsd = { desk.setTapUsd(it) },
            onSlip = { pct -> scope.launch { desk.saveSettings(mapOf("maxEntrySlippage" to pct)) } },
            live = s.mode == "live",
            liveTrailPct = s.liveTrailPct,
            split = s.liveBook != null,
            aiLive = s.liveBook?.manualOnly == false,
            onSellLive = { mint, symbol ->
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch { desk.oneTapSell(mint, symbol, live = true) }
            },
            liveTapUsd = com.dirk.nightdesk.LiveTap.size(s),
            liveBlock = com.dirk.nightdesk.LiveTap.block(s),
            liveHeld = com.dirk.nightdesk.LiveTap.held(s),
            paperHeld = s.positions.associate { it.mint to it.pnlUsd },
            onLiveBuy = { mint, symbol ->
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch { desk.liveTapBuy(mint, symbol, com.dirk.nightdesk.LiveTap.size(s), com.dirk.nightdesk.LiveTap.block(s)) }
            }
        )
    }

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

    val view = androidx.compose.ui.platform.LocalView.current
    val dark = P.isDark
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    // v13.11 limit / take-profit / stop orders (paper and live).
    val orderActions = snap?.let { s ->
        orderActionsFor(
            s,
            oneTap?.tapUsd ?: 50.0,
            { side, mint, basis, value, live, pct, size -> scope.launch { desk.placeOrder(side, mint, basis, value, live, pct, size) } },
            { id -> scope.launch { desk.cancelOrder(id) } }
        )
    }
    val positionCount = snap?.positions?.size ?: 0
    Scaffold(
        containerColor = P.bg,
        bottomBar = {
            Column {
                Box(Modifier.fillMaxWidth().height(1.dp).background(P.line))
                NavigationBar(containerColor = P.nav, tonalElevation = 0.dp) {
                    NAV_TABS.forEachIndexed { index, (label, icon) ->
                        NavigationBarItem(
                            selected = tab == index,
                            onClick = {
                                // Tapping Settings always lands on the Settings list, not a sub-screen left open.
                                if (index == TAB_SETTINGS) settingsSub = null
                                tab = index
                            },
                            label = { Text(label, fontSize = 11.sp, maxLines = 1, fontWeight = if (tab == index) FontWeight.SemiBold else FontWeight.Medium) },
                            icon = {
                                BadgedBox(badge = {
                                    if (index == TAB_HOME && positionCount > 0) Badge(containerColor = P.accent, contentColor = P.onAccent) { Text("$positionCount") }
                                }) { Icon(deskIcon(icon), contentDescription = label, modifier = Modifier.size(22.dp)) }
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = P.accent,
                                selectedTextColor = P.accent,
                                unselectedIconColor = P.dim,
                                unselectedTextColor = P.dim,
                                indicatorColor = P.accent.copy(alpha = 0.18f)
                            )
                        )
                    }
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).background(P.bg)) {
            if (tab != 1) Header(status = status, live = live, mode = snap?.mode ?: "paper", liveScope = snap?.liveScope)
            snap?.feedBanner?.let { banner ->
                StatusPill(text = "Feed: $banner", tint = Amber)
            }
            if (!error.isNullOrBlank() || (!live && status.startsWith("Reconnecting"))) {
                ConnectionPill(
                    message = shortConnectionError(error, status),
                    canUseLastGood = !lastGood.isNullOrBlank() && lastGood != activeUrl,
                    onUseLastGood = { scope.launch { desk.useLastGood() } },
                    onEditLink = {
                        tab = TAB_SETTINGS
                        settingsSub = "link"
                    }
                )
            }
            notice?.let { note ->
                val tint = if (note.ok) P.up else P.down
                Row(
                    Modifier
                        .padding(horizontal = 16.dp, vertical = 4.dp)
                        .deskCard(radius = 16.dp, color = tint.copy(alpha = 0.12f))
                        .padding(start = 14.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        note.text,
                        color = P.ink,
                        modifier = Modifier.weight(1f),
                        fontSize = 13.sp
                    )
                    TextButton(onClick = { desk.dismissNotice() }) { Text("Dismiss", color = tint, fontWeight = FontWeight.SemiBold) }
                }
            }
            when (tab) {
                TAB_HOME -> BookScreen(
                    snap,
                    onClose = { mint -> scope.launch { desk.closePosition(mint) } },
                    onCloseLive = { mint -> scope.launch { desk.closePosition(mint, live = true) } },
                    onSell = { mint, percent -> scope.launch { desk.sellPosition(mint, percent) } },
                    onReset = { scope.launch { desk.resetPaperBook() } },
                    onReady = { ready -> scope.launch { desk.setOperatorReady(ready) } },
                    onBuy = { mint, ignore -> scope.launch { desk.buyPosition(mint, null, ignore) } },
                    oneTap = oneTap,
                    onOpenCoin = { mint ->
                        addPrefill = mint to ((addPrefill?.second ?: 0) + 1)
                        tab = 2
                    },
                    orders = orderActions,
                    onDismissCrash = { scope.launch { desk.dismissClientCrash() } },
                    onOpenEngine = { tab = TAB_ENGINE }
                )
                TAB_TAPE -> TapeScreen(
                    snap?.events.orEmpty(),
                    positionCapUsd = snap?.positionCapUsd,
                    cooldowns = snap?.cooldowns.orEmpty(),
                    onBuy = { mint, size, ignore -> scope.launch { desk.buyPosition(mint, size, ignore) } },
                    feedSources = snap?.feedSources.orEmpty(),
                    positionMints = snap?.positions.orEmpty().map { it.mint }.toSet(),
                    oneTap = oneTap,
                    headerStatus = status,
                    headerLive = live,
                    mode = snap?.mode ?: "paper",
                    liveScope = snap?.liveScope,
                    tapeQuotes = snap?.tapeQuotes.orEmpty(),
                    rawTape = snap?.rawTape.orEmpty(),
                    tapeOrders = orderActions,
                    safetyChips = snap?.safetyChips.orEmpty()
                )
                TAB_SEARCH -> AddCoinScreen(desk, snap, addPrefill, oneTap)
                TAB_ENGINE -> EngineScreen(snap?.strategy, snap?.perf.orEmpty(), onStrategy = { patch -> scope.launch { desk.saveStrategy(patch) } }, onReset = { scope.launch { desk.resetStrategy() } })
                else -> when (settingsSub) {
                    "link" -> SubScreen("Link", onBack = { settingsSub = null }) { LinkScreen(desk) }
                    "recap" -> SubScreen("Recap", onBack = { settingsSub = null }) {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) { RecapCard(desk) }
                    }
                    "pump" -> SubScreen("Pump terminal", onBack = { settingsSub = null }) { PumpScreen() }
                    else -> SettingsScreen(
                        snap,
                        oneTap,
                        onStrategy = { patch -> scope.launch { desk.saveStrategy(patch) } },
                        onOpen = { settingsSub = it },
                        onOpenEngine = { tab = TAB_ENGINE },
                        onReset = { scope.launch { desk.resetPaperBook() } }
                    ) { patch -> scope.launch { desk.saveSettings(patch) } }
                }
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
                Text(
                    ask.message + if (ask.live) {
                        "\n\nLive buy. Real money at the live size. The engine, the analyst, a filter miss, the score, and a watch do not block it. Slippage, pool depth, the wallet check, and the hard stop still apply."
                    } else {
                        "\n\nPaper fill only. Slippage cap, pool depth, cash and the hard stop still apply."
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    desk.dismissHardKill()
                    scope.launch {
                        if (ask.live) desk.liveOverrideBuy(ask.mint, ask.symbol, ask.sizeUsd ?: com.dirk.nightdesk.LiveTap.size(snap))
                        else desk.buyPosition(ask.mint, ask.sizeUsd, ignoreCooldown = true, confirmHardKill = true, confirmSize = ask.confirmSize, symbol = ask.symbol)
                    }
                }) { Text("Buy anyway", color = Coral) }
            },
            dismissButton = {
                TextButton(onClick = { desk.dismissHardKill() }) { Text("Cancel", color = Dim) }
            }
        )
    }
}

@Composable
private fun Header(status: String, live: Boolean, mode: String, compact: Boolean = false, liveScope: String? = null, subline: (@Composable () -> Unit)? = null) {
    // v13.32 one slim header on every tab.
    val box = if (compact) 30.dp else 34.dp
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = if (compact) 6.dp else 10.dp, bottom = if (compact) 2.dp else 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(box).clip(RoundedCornerShape(12.dp)).background(P.accent), contentAlignment = Alignment.Center) {
            DeskIcon("moon", tint = P.onAccent, size = if (compact) 18.dp else 20.dp)
        }
        Spacer(Modifier.width(if (compact) 10.dp else 12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text("Night", color = P.ink, fontSize = if (compact) 17.sp else 18.sp, fontWeight = FontWeight.Bold)
                Text(" Desk", color = P.muted, fontSize = if (compact) 17.sp else 18.sp, fontWeight = FontWeight.Medium)
            }
            // v13.4: on the Tape tab the Scout line takes this spot while the feed is live.
            if (subline != null && live) subline() else Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(if (live) P.up else P.down))
                Spacer(Modifier.width(6.dp))
                Text(if (live) "Feed live · $status" else status, color = P.dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        // v13.32 the theme toggle lives in Settings → Appearance. The header keeps only the mode pill.
        val isLive = mode == "live"
        Text(
            when {
                isLive && liveScope == "manual" -> "LIVE · YOU"
                isLive && liveScope == "all" -> "LIVE · AI+YOU"
                isLive -> "LIVE · REAL $"
                else -> mode.uppercase()
            },
            color = if (isLive) P.onDown else P.onAccent,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 11.sp,
            letterSpacing = 1.sp,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(if (isLive) P.down else P.accent).padding(horizontal = 10.dp, vertical = 5.dp)
        )
    }
}

private fun liveCashLabel(book: LiveBookInfo, wallet: com.dirk.nightdesk.WalletInfo?): String =
    com.dirk.nightdesk.OneTap.liveCashLabel(
        wallet?.solBalance,
        wallet?.solPriceUsd,
        wallet?.usdcBalance,
        book.cashUsd,
        book.cashKnown,
        book.balanceError
    )

@Composable
private fun BookScreen(
    snap: DeskSnapshot?,
    onClose: (String) -> Unit,
    onSell: (String, Int) -> Unit,
    onReset: () -> Unit,
    onReady: (Boolean) -> Unit,
    onBuy: (String, Boolean) -> Unit,
    oneTap: OneTapUi? = null,
    /** v13.6 tapping a held coin opens its Add coin card. */
    onOpenCoin: (String) -> Unit = {},
    /** v13.7 close a live-book position (real sell). */
    onCloseLive: (String) -> Unit = {},
    /** v13.11 limit / take-profit / stop orders. */
    orders: OrderActions? = null,
    onDismissCrash: () -> Unit = {},
    /** v13.32 the engine line opens the Engine tab. */
    onOpenEngine: () -> Unit = {}
) {
    val openPnl = snap?.positions?.sumOf { it.pnlUsd } ?: 0.0
    val liveBook = snap?.liveBook
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { LastCrashCard() }
        if (showDeskCrash(snap?.lastClientCrashVersion.orEmpty(), snap?.lastClientCrashDismissed == true, BuildConfig.VERSION_NAME) && !snap?.lastClientCrash.isNullOrBlank()) {
            item {
                Column(Modifier.deskCard(radius = 16.dp).padding(14.dp)) {
                    Text("LAST CRASH ON THE DESK", color = P.down, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                    Text(snap?.lastClientCrash.orEmpty().take(400), color = P.muted, fontSize = 12.sp)
                    TextButton(onClick = onDismissCrash) { Text("Dismiss", color = P.muted) }
                }
            }
        }
        // v13.32 the one number first: equity, today's result, the curve.
        item { HeroCard(snap, openPnl) }
        snap?.strategy?.let { engine -> item { EngineLine(engine, onOpenEngine) } }
        item {
            SectionTitle(
                if (liveBook != null) "Paper · AI" else "Positions",
                "${signed(openPnl)} · ${snap?.positions?.size ?: 0} open · exposure ${money(snap?.exposureUsd ?: 0.0)}",
                pnlTint(openPnl)
            )
        }
        if (snap == null || snap.positions.isEmpty()) {
            item {
                Text(
                    if (snap?.strategy?.enabled == true) "No open positions. The engine buys when a watched coin fires a signal."
                    else "No open positions. A name still has to clear every hard filter.",
                    color = P.muted,
                    fontSize = 14.sp,
                    modifier = Modifier.padding(vertical = 4.dp)
                )
            }
        } else {
            itemsIndexed(snap.positions, key = { index, pos -> "${pos.mint}#$index" }) { _, pos ->
                OpenPositionCard(pos, onClose, onSell, armPct = snap.trailArmPct, trailOn = snap.trailTakeProfit, oneTap = oneTap, onOpenCoin = onOpenCoin, orders = orders)
            }
        }
        if (liveBook != null) {
            item {
                SectionTitle(
                    "Live positions",
                    "${signed(liveBook.openPnlUsd)} · ${liveBook.positions.size} open · ${liveCashLabel(liveBook, snap?.wallet)}",
                    P.down
                )
            }
            if (liveBook.positions.isEmpty()) {
                item { Text("No live positions. LIVE BUY on a coin sends a real ${money(liveBook.tradeUsd)} buy.", color = P.muted, fontSize = 13.sp) }
            } else {
                itemsIndexed(liveBook.positions, key = { index, pos -> "live:${pos.mint}#$index" }) { _, pos ->
                    OpenPositionCard(pos, onCloseLive, { mint, _ -> onCloseLive(mint) }, armPct = snap.trailArmPct, trailOn = snap.trailTakeProfit, oneTap = oneTap, onOpenCoin = onOpenCoin, orders = orders)
                }
            }
            item {
                Text(
                    (if (liveBook.manualOnly) "Live: manual only · AI: paper. " else "Live: manual + AI. ") +
                        "${money(liveBook.tradeUsd)} per trade · trail ${"%.1f".format(Locale.US, liveBook.trailPct * 100)}% · hard stop −${"%.0f".format(Locale.US, snap.stopLossPct * 100)}% · " +
                        (liveBook.dailyCapUsd?.let { "daily cap ${money(it)}" } ?: "no daily max") + ".",
                    color = P.muted,
                    fontSize = 12.sp
                )
            }
        }
        // v13.32 the rest folds into sections so the positions get the screen.
        if (orders != null) {
            val n = orders.orders.size
            item { Section("Orders", trailing = if (n == 0) "none" else "$n open", collapsible = true, open = n > 0, padded = true) { OrdersCard(orders) } }
        }
        item { Section("Wallet & live", collapsible = true, open = false, padded = true) { WalletCard(snap); LiveReadyCard(snap, onReady) } }
        val notes = snap?.advice.orEmpty()
        item { Section("Advisor", trailing = if (notes.isEmpty()) "quiet" else "${notes.size}", collapsible = true, open = notes.isNotEmpty(), padded = true) { AdvisorCard(notes, snap?.cooldowns.orEmpty(), onBuy) } }
        val recent = snap?.closed.orEmpty().takeLast(20).asReversed()
        item {
            Section("Recent trades", trailing = "${snap?.closed?.size ?: 0}", collapsible = true, open = true) {
                if (recent.isEmpty()) {
                    Text("No closed trades yet. Stops, take-profits and manual sells land here.", color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 12.dp))
                } else {
                    recent.forEachIndexed { i, trade ->
                        ListRow(
                            trade.symbol,
                            "${com.dirk.nightdesk.OneTap.exitLabel(trade.exitCode)} · ${px(trade.entryPrice)} → ${px(trade.exitPrice)} · ${clock(trade.closedAt)}",
                            titleColor = if (trade.exitCode == "GAP_RUG") P.down else P.ink,
                            trailing = { Text(signed(trade.pnlUsd), color = pnlTint(trade.pnlUsd), fontSize = 14.sp, fontWeight = FontWeight.Bold) }
                        )
                        if (i < recent.lastIndex) RowDivider()
                    }
                }
            }
        }
        if (snap?.mode != "live" || liveBook != null) {
            item { Text("Reset the paper book under Settings → Paper book.", color = P.faint, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

/** v13.32 one line of engine status under the hero. Tap for the Engine tab. */
@Composable
private fun EngineLine(engine: com.dirk.nightdesk.StrategyView, onOpen: () -> Unit) {
    val best = engine.variants.filter { it.trades > 0 }.maxByOrNull { it.netUsd }
    val open = engine.variants.filter { it.active }.sumOf { it.open }
    Row(
        Modifier.deskCard(radius = 14.dp).clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (engine.enabled) P.up else P.faint))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(if (engine.enabled) "Engine on · paper" else "Engine off", color = P.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text(
                if (!engine.enabled) "Analyst passes are bought on sight."
                else "watching ${engine.watching} · $open open · ${engine.signals} signals" +
                    (if (best != null) " · best ${com.dirk.nightdesk.Strategy.label(best)} ${com.dirk.nightdesk.Strategy.signedUsd(best.netUsd)}" else ""),
                color = P.muted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Chevron()
    }
}

@Composable
private fun HeroCard(snap: DeskSnapshot?, openPnl: Double) {
    val equity = snap?.equityUsd ?: 0.0
    val start = snap?.startingBalanceUsd ?: 100.0
    val midnight = java.time.LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
    val base = com.dirk.nightdesk.dayBase(snap?.equityPoints.orEmpty(), start, midnight)
    val day = equity - base
    val session = snap?.sessionPnlUsd ?: 0.0
    fun tint(n: Double) = if (n > 0) P.up else if (n < 0) P.down else P.ink
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Brush.linearGradient(listOf(P.heroFrom, P.heroTo)))
            .border(1.dp, P.accent.copy(alpha = 0.25f), RoundedCornerShape(18.dp))
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Equity", color = P.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp, modifier = Modifier.weight(1f))
            val live = snap?.mode == "live" && snap.liveBook == null
            Chip(if (live) "LIVE" else if (snap?.liveBook != null) "PAPER · AI" else "PAPER", if (live) P.onDown else P.onAccent, if (live) P.down else P.accent, size = 10)
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(money(equity), color = P.ink, fontSize = 36.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1).sp, modifier = Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(bottom = 6.dp)) {
                Text("TODAY", color = P.faint, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
                Text(signed(day) + (if (base > 0) "  ${pct(day / base)}" else ""), color = tint(day), fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
            }
        }
        Sparkline(snap?.equityPoints.orEmpty().map { it.equity }, start, Modifier.padding(top = 8.dp, bottom = 8.dp))
        Row(Modifier.fillMaxWidth()) {
            Stat("Cash", money(snap?.cashUsd))
            Stat("Open", "${snap?.positions?.size ?: 0} · ${signed(openPnl)}", tint(openPnl))
            Stat("Session", signed(session), tint(session))
            Stat("Exposure", money(snap?.exposureUsd ?: 0.0))
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
            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = P.onAccent)
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
private fun LiveReadyCard(snap: DeskSnapshot?, onReady: (Boolean) -> Unit) {
    val readiness = snap?.readiness
    Column(Modifier.fillMaxWidth().background(P.card, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text("LIVE READY", color = Lime, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.4.sp)
        Text(
            if (readiness == null) "Waiting for the desk checklist."
            else com.dirk.nightdesk.OneTap.liveStatusChip(
                readiness.mode,
                readiness.operatorReady,
                snap.liveBook?.tradeUsd ?: snap.liveTradeUsd,
                snap.liveBook?.dailyCapUsd ?: snap.liveDailyCapUsd,
                snap.wallet?.solBalance
            ),
            color = Ink,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
            lineHeight = 18.sp
        )
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text("Mark checklist ready", color = Ink, modifier = Modifier.weight(1f), fontSize = 14.sp)
            Switch(
                checked = readiness?.operatorReady == true,
                onCheckedChange = onReady,
                enabled = readiness != null,
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = OnAccent)
            )
        }
        Text("Does not turn LIVE_TRADING on or store a key.", color = Dim, fontSize = 12.sp)
    }
}

@Composable
private fun AdvisorCard(notes: List<AdviceNote>, cooldowns: List<MintCooldown>, onBuy: (String, Boolean) -> Unit) {
    var confirmMint by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().background(P.card, RoundedCornerShape(18.dp)).padding(16.dp)) {
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
internal fun ResetCard(amountUsd: Double, onReset: () -> Unit) {
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
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = OnAccent)
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
            Button(onClick = { onApply(text) }, colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = OnAccent)) {
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
            Button(onClick = { text.toDoubleOrNull()?.let { onSave(mapOf("minVolume1hUsd" to it)) } }, colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = OnAccent)) {
                Text("Apply")
            }
        }
        Text("$1,000–$500,000. Default $10,000 until you change it.", color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OpenPositionCard(
    pos: PositionRow,
    onClose: (String) -> Unit,
    onSell: (String, Int) -> Unit = { mint, _ -> onClose(mint) },
    armPct: Double = 0.12,
    trailOn: Boolean = false,
    oneTap: OneTapUi? = null,
    onOpenCoin: (String) -> Unit = {},
    orders: OrderActions? = null
) {
    val up = pos.pnlUsd >= 0
    val context = LocalContext.current
    var sellAsk by remember { mutableStateOf<Int?>(null) }
    var expanded by rememberSaveable(pos.mint) { mutableStateOf(false) }
    Column(Modifier.deskCard(radius = 16.dp).padding(horizontal = 12.dp, vertical = 10.dp)) {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Open ${pos.symbol} coin card") { onOpenCoin(pos.mint) }, verticalAlignment = Alignment.CenterVertically) {
            CoinAvatar(pos.symbol, pos.mint, ring = if (pos.pnlUsd > 0) P.up else if (pos.pnlUsd < 0) P.down else null, size = if (expanded) 40.dp else 32.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(pos.symbol, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(6.dp))
                    if (pos.live) Chip("LIVE", P.onDown, P.down, size = 10)
                    else {
                        val tag = pos.tag ?: if (pos.entry == "manual") "manual" else null
                        if (tag != null) Chip(tag.uppercase(), P.accent, P.accent.copy(alpha = 0.16f), size = 10)
                    }
                    if (!expanded) {
                        Spacer(Modifier.width(6.dp))
                        Text("${money(pos.costUsd)} · ${heldFor(pos.openedAt)}", color = P.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (pos.safetyChip.isNotBlank() || pos.bundleChip.isNotBlank()) {
                    Text(
                        listOf(pos.safetyChip, pos.bundleChip).filter { it.isNotBlank() }.joinToString(" · "),
                        color = if (pos.safetyChip.startsWith("Blocked")) P.down else P.dim,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (expanded) {
                    Text("${pos.source.ifBlank { "auto" }} · score ${num(pos.score, "%.2f")}" + (if (pos.lpUnlocked) " · LP unlocked" else ""), color = if (pos.lpUnlocked) P.amber else P.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                PnlChip(pos.pnlUsd, pos.pnlPct)
                Text(money(pos.marketValueUsd), color = P.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                if (expanded) {
                    val net = pos.netPnlUsd
                    val netText = if (net != null && net.isFinite()) {
                        val pct = pos.netPnlPct
                        val slip = pos.exitSlippage
                        buildString {
                            append("Net ")
                            append(signed(net))
                            if (pct != null && pct.isFinite()) append(" · ${"%.1f".format(java.util.Locale.US, pct * 100)}%")
                            if (slip != null && slip.isFinite()) append(" · slip ${"%.2f".format(java.util.Locale.US, slip * 100)}%")
                        }
                    } else "Net —"
                    Text(
                        netText,
                        color = if (net == null || !net.isFinite()) P.muted else if (net >= 0) P.up else P.down,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
        MarkUpdated(pos)
        CoinSpark(pos.marks, pos.entryPrice, height = if (expanded) 36.dp else 20.dp)
        if (!expanded) {
            // Collapsed: how far the mark sits above the stop, as a thin bar.
            val room = stopRoom(pos)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                ThinBar(room, if (room < 0.25f) P.down else if (room < 0.5f) P.amber else P.up, Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text("stop ${num(pos.stopDistancePct, "%.1f")}% away", color = P.muted, fontSize = 11.sp, maxLines = 1)
            }
            Disclosure(open = false, tag = "details-${pos.symbol}") { expanded = true }
        } else {
        StopTrailBar(stopBarModel(pos.stopPrice, pos.entryPrice, pos.markPrice, pos.peakPrice, armPct, trailOn))
        Column(
            Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(12.dp)).background(P.surface).border(1.dp, P.line, RoundedCornerShape(12.dp)).padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row {
                PosStat("Entry", px(pos.entryPrice))
                PosStat("Mark", px(pos.markPrice), if (up) P.up else P.down)
                PosStat("Stop", fmtPx(pos.stopPrice), P.down)
            }
            Row {
                PosStat("Size", money(pos.costUsd))
                PosStat("Held", heldFor(pos.openedAt))
                PosStat("To stop", "${num(pos.stopDistancePct, "%.1f")}%")
            }
        }
        // v13.9: LIVE BUY / LIVE SELL side by side on every paper card.
        if (oneTap != null && !pos.live) LivePair(oneTap, pos.mint, pos.symbol, Modifier.padding(top = 4.dp), compact = true)
        // v13.3 one tap: closes 100% now, no dialog. The 25 / 50 / 100 buttons below still ask first.
        if (oneTap != null) {
            // v13.7: live-book cards sell for real; on an armed desk the AI's paper cards sell on paper.
            val inFlight = if (pos.live) oneTap.sellingLive(pos.mint) else oneTap.selling(pos.mint)
            val label = when {
                pos.live -> "⚡ Sell now LIVE"
                oneTap.split || !oneTap.live -> "⚡ Sell now PAPER"
                else -> oneTap.sellLabel
            }
            BigButton(
                if (inFlight) "Selling…" else label,
                P.down,
                P.onDown,
                Modifier.fillMaxWidth().padding(top = 2.dp),
                height = 34.dp,
                enabled = !inFlight
            ) { if (pos.live) oneTap.onSellLive(pos.mint, pos.symbol) else oneTap.onSell(pos.mint, pos.symbol) }
        }
        // Sell 25 / 50 / 100. Each one still asks first; the confirm never touches the connection.
        // v13.7: a live position closes in full only.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!pos.live) {
                BigButton("Sell 25%", P.card3, P.ink, Modifier.weight(1f), border = P.lineStrong, height = 34.dp) { sellAsk = 25 }
                BigButton("Sell 50%", P.card3, P.ink, Modifier.weight(1f), border = P.lineStrong, height = 34.dp) { sellAsk = 50 }
            }
            BigButton(if (pos.live) "Sell 100% LIVE" else "Sell 100%", P.down, P.onDown, Modifier.weight(1f), height = 34.dp) { sellAsk = 100 }
        }
        // v13.11 take profit / stop orders on this position.
        if (orders != null) {
            PositionOrders(orders, pos.mint, pos.symbol, pos.live, pos.markPrice.takeIf { it > 0 }, pos.entryPrice.takeIf { it > 0 }, pos.stopPrice.takeIf { it > 0 }, Modifier.padding(top = 12.dp))
        }
        FlowRow(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            chartLinks(pos.mint).forEach { (label, url) ->
                Text(
                    label,
                    color = P.dim,
                    fontSize = 12.5.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .border(1.dp, P.lineStrong, RoundedCornerShape(50))
                        .clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
                        .padding(horizontal = 12.dp, vertical = 7.dp)
                )
            }
        }
            Disclosure(open = true, tag = "details-${pos.symbol}") { expanded = false }
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
            text = {
                Text(
                    if (pos.live) "LIVE: a real on-chain sell from the desk wallet at the market. The hard stop still fires on its own."
                    else "Paper fill at the mark against the same pool model as a stop. The hard stop keeps guarding what is left."
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        sellAsk = null
                        if (pending >= 100) onClose(pos.mint) else onSell(pos.mint, pending)
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = P.down, contentColor = P.onDown)
                ) { Text("Sell", fontSize = 16.sp, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { sellAsk = null }) { Text("Cancel", color = Dim) } }
        )
    }
}

@Composable
private fun CoinSpark(points: List<PricePoint>, entry: Double, height: androidx.compose.ui.unit.Dp = 36.dp) {
    if (points.isEmpty()) return
    val drawn = if (points.size >= 2) points else listOf(points[0], points[0])
    val up = drawn.last().priceUsd >= entry
    val color = if (up) P.up else P.down
    Canvas(Modifier.fillMaxWidth().height(height).padding(top = 4.dp)) {
        var min = drawn[0].priceUsd
        var max = drawn[0].priceUsd
        for (p in drawn) {
            if (p.priceUsd < min) min = p.priceUsd
            if (p.priceUsd > max) max = p.priceUsd
        }
        if (entry.isFinite() && entry > 0.0) {
            if (entry < min) min = entry
            if (entry > max) max = entry
        }
        val span = if (max - min > 0.0) max - min else 1.0
        val path = Path()
        drawn.forEachIndexed { i, p ->
            val x = i.toFloat() / (drawn.size - 1).toFloat() * size.width
            val y = size.height - ((p.priceUsd - min) / span).toFloat() * size.height
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, color, style = Stroke(width = 2.5f))
    }
}

@Composable
private fun RowScope.PosStat(label: String, value: String, tint: Color = P.ink) {
    Column(Modifier.weight(1f)) {
        Text(label, color = P.muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = tint, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
            "${if (pos.entry == "manual") "Manual buy" else pos.source}  ·  score ${num(pos.score, "%.2f")}",
            color = Dim,
            fontSize = 12.sp
        )
        MarkUpdated(pos)
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


@Composable
private fun TapeScreen(
    events: List<TapeEvent>,
    positionCapUsd: Double?,
    cooldowns: List<MintCooldown>,
    onBuy: (String, Double?, Boolean) -> Unit,
    feedSources: List<FeedSource> = emptyList(),
    positionMints: Set<String> = emptySet(),
    oneTap: OneTapUi? = null,
    initialScoutOpen: Boolean? = null,
    initialSheetOpen: Boolean = false,
    headerStatus: String = "Connected",
    headerLive: Boolean = true,
    mode: String = "paper",
    liveScope: String? = null,
    tapeQuotes: Map<String, com.dirk.nightdesk.TapeQuote> = emptyMap(),
    rawTape: List<com.dirk.nightdesk.RawTapeRow> = emptyList(),
    tapeOrders: OrderActions? = null,
    safetyChips: List<com.dirk.nightdesk.SafetyChip> = emptyList()
) {
    var stage by remember { mutableStateOf("all") }
    var tapeView by rememberSaveable { mutableStateOf("coins") }
    var coinFilter by rememberSaveable { mutableStateOf("all") }
    val tapeContext = LocalContext.current
    val tapePrefs = remember { tapeContext.getSharedPreferences("night_desk_local", android.content.Context.MODE_PRIVATE) }
    var tapeSort by remember { mutableStateOf(TapeSort.parse(tapePrefs.getString("tape_sort", null))) }
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
    // v13.4: Scout list collapsed to one line by default, remembered on this phone.
    var scoutOpen by remember { mutableStateOf(initialScoutOpen ?: tapePrefs.getBoolean(com.dirk.nightdesk.TapeToolbar.PREF_SCOUT_OPEN, false)) }
    var sheetOpen by remember { mutableStateOf(initialSheetOpen) }
    var sortMenu by remember { mutableStateOf(false) }
    var filterMenu by remember { mutableStateOf(false) }
    val coinFilters = listOf("all" to "All", "open" to "Open", "trade" to "Passed", "near" to "Near miss", "killed" to "Killed")
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        // v13.4 compact header: the Scout line (tap to open the full list) sits under the title.
        Header(headerStatus, headerLive, mode, compact = true, liveScope = liveScope) {
            ScoutLine(feedSources, scoutOpen) {
                scoutOpen = !scoutOpen
                tapePrefs.edit().putBoolean(com.dirk.nightdesk.TapeToolbar.PREF_SCOUT_OPEN, scoutOpen).apply()
            }
        }
        // v13.4 toolbar, pinned above the list: one-tap chip, sort, filter and the Coins / Raw log toggle in one row.
        Column(
            Modifier.fillMaxWidth().background(P.bg).padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 4.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            if (scoutOpen) ScoutStatusList(feedSources)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (tapeView == "coins" && oneTap != null) OneTapChip(oneTap, Modifier.weight(1f)) { sheetOpen = true }
                else Text(if (tapeView == "coins") "Tape" else "Activity log", color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (tapeView == "coins") {
                Spacer(Modifier.width(6.dp))
                // v13.27 sort: Newest (default), Volume, Score. Saved on this phone only.
                Box {
                    ToolChip(com.dirk.nightdesk.TapeToolbar.sortChip(tapeSort), on = true) { sortMenu = true }
                    DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }, containerColor = P.card) {
                        TapeSort.entries.forEach { mode ->
                            DropdownMenuItem(
                                text = { Text((if (tapeSort == mode) "✓ " else "   ") + mode.label, color = P.ink, fontWeight = if (tapeSort == mode) FontWeight.Bold else FontWeight.Normal) },
                                onClick = {
                                    tapeSort = mode
                                    tapePrefs.edit().putString("tape_sort", mode.name).apply()
                                    sortMenu = false
                                }
                            )
                        }
                    }
                }
                Spacer(Modifier.width(6.dp))
                Box {
                    ToolChip((coinFilters.firstOrNull { it.first == coinFilter }?.second ?: "All") + " ▾", on = coinFilter != "all") { filterMenu = true }
                    DropdownMenu(expanded = filterMenu, onDismissRequest = { filterMenu = false }, containerColor = P.card) {
                        coinFilters.forEach { (id, label) ->
                            DropdownMenuItem(
                                text = { Text((if (coinFilter == id) "✓ " else "   ") + label, color = P.ink, fontWeight = if (coinFilter == id) FontWeight.Bold else FontWeight.Normal) },
                                onClick = {
                                    coinFilter = id
                                    filterMenu = false
                                }
                            )
                        }
                    }
                }
                }
                Spacer(Modifier.width(6.dp))
                IconToggle(
                    listOf("coins" to "Coins", "log" to "Raw log"),
                    tapeView,
                    icons = mapOf("coins" to "coins", "log" to "list")
                ) { tapeView = it }
            }
        }
        // v13.1: in Coins view each card has its own Buy, so this bar shows once a coin is picked.
        // The Raw log view always shows it, with Pause/Live for the follow behaviour.
        if (tapeView == "log" || selected != null) Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            val mintLabel = selected?.mint
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (mintLabel == null) "Select a mint on the tape" else "Selected ${selected?.symbol ?: mintLabel.take(4)}",
                        color = P.accent,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    Text(
                        if (capText.isBlank()) "Buy size uses the position cap" else "Buy size starts at the cap $$capText",
                        color = Dim,
                        fontSize = 13.sp
                    )
                }
                Button(
                    onClick = { toggleTape() },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (tapePaused) P.accent else P.card3,
                        contentColor = if (tapePaused) P.onAccent else P.ink
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
                colors = ButtonDefaults.buttonColors(containerColor = P.up, contentColor = P.onUp)
            ) { Text("Buy", fontSize = 16.sp, fontWeight = FontWeight.ExtraBold) }
        }
        if (tapeView == "coins") {
            val coins = sortCoins(
                remember(idKey, positionMints, tapeQuotes, rawTape) { coinCards(events, positionMints, quotes = tapeQuotes, raw = rawTape) }
                    .filter { coinFilter == "all" || it.verdict.name.lowercase() == coinFilter || (coinFilter == "trade" && it.verdict == Verdict.BOUGHT) },
                tapeSort
            )
            val coinState = rememberLazyListState()
            var pinNewest by remember { mutableStateOf(true) }
            val coinStick = remember {
                object : NestedScrollConnection {
                    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                        if (source == NestedScrollSource.UserInput && consumed.y != 0f) {
                            pinNewest = coinState.firstVisibleItemIndex == 0 && coinState.firstVisibleItemScrollOffset < 8
                        }
                        return Offset.Zero
                    }
                }
            }
            LaunchedEffect(coins.firstOrNull()?.mint, tapeSort) {
                if (tapeSort == TapeSort.NEWEST && pinNewest && coins.isNotEmpty() && !coinState.isScrollInProgress) {
                    runCatching { coinState.scrollToItem(0) }
                }
            }
            LazyColumn(
                state = coinState,
                modifier = Modifier.weight(1f).fillMaxWidth().nestedScroll(coinStick),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (coins.isEmpty()) {
                    item { Text("No coins for this filter yet. The Scout adds a card as each new pair lands.", color = P.dim, fontSize = 16.sp) }
                }
                itemsIndexed(coins, key = { index, c -> "${c.mint}#$index" }) { _, coin ->
                    CoinCardRow(
                        coin,
                        selected = selected?.mint == coin.mint,
                        onSelect = { selected = coin.event },
                        onBuy = {
                            selected = coin.event
                            sizeError = null
                            sizeText = capText
                            askBuy = true
                        },
                        oneTap = oneTap,
                        orders = tapeOrders,
                        safety = safetyChips.find { it.mint == coin.mint }?.safety ?: "",
                        bundle = safetyChips.find { it.mint == coin.mint }?.bundle ?: ""
                    )
                }
            }
        } else {
        // v12.3: one scrollable row of stage chips.
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            stages.forEach { name ->
                PillChip(name.replaceFirstChar { it.uppercase() }, stage == name) { stage = name }
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
                            .deskCard(radius = 14.dp, color = if (active) P.accent.copy(alpha = 0.12f) else P.card)
                            .padding(12.dp)
                    ) {
                        Text("${clock(event.ts)}  ${event.stage.uppercase()}", color = stageColor(event.stage), fontFamily = FontFamily.Monospace, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        Text(event.message, color = Ink, fontSize = 15.sp, lineHeight = 21.sp)
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
                    colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = OnAccent)
                ) { Text(pausedLabel(fresh)) }
            }
        }
        }
    }
    // v13.4 One Tap sheet: the full size + slippage controls, Sell all and the fine print.
    if (sheetOpen && oneTap != null) {
        androidx.activity.compose.BackHandler { sheetOpen = false }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)).clickable { sheetOpen = false })
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .background(P.bg)
                .border(1.dp, P.lineStrong, RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .clickable(enabled = false) {}
                .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).width(40.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(P.lineStrong))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("One tap", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).padding(start = 4.dp))
                TextButton(onClick = { sheetOpen = false }) { Text("Done", color = P.accent, fontWeight = FontWeight.Bold) }
            }
            OneTapBar(oneTap)
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
                    Text("Size starts at the current cap. A larger number is filled at the cap, never above it. No add while this mint is open. This Buy fills the paper book. A real swap is only LIVE BUY, and only after the checklist is marked.")
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
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
        OutlinedTextField(url, { url = it }, label = { Text("Override URL") }, placeholder = { Text("https://<tunnel>.trycloudflare.com") }, singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        OutlinedTextField(token, { token = it }, label = { Text("Desk token") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Hold this URL instead of the beacon", color = Ink, modifier = Modifier.weight(1f), fontSize = 14.sp)
            Switch(
                checked = useManual,
                onCheckedChange = { useManual = it },
                colors = SwitchDefaults.colors(checkedTrackColor = Lime, checkedThumbColor = OnAccent)
            )
        }
        Button(
            onClick = { if (loaded) scope.launch { desk.saveLink(url, token, useManual) } },
            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = OnAccent)
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
    unfocusedBorderColor = P.lineStrong,
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
    var hidden by remember { mutableStateOf(CrashLog.isHidden(context)) }
    val crash = CrashLog.read(context)
    if (!showPhoneCrash(crash, hidden, BuildConfig.VERSION_NAME) || crash.isNullOrBlank()) return
    Column(Modifier.fillMaxWidth().background(P.down.copy(alpha = 0.12f), RoundedCornerShape(18.dp)).padding(16.dp)) {
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
                CrashLog.hide(context)
                hidden = true
            }) { Text("Dismiss", color = Dim) }
        }
    }
}

private fun px(n: Double): String = com.dirk.nightdesk.PriceText.px(n)

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

/** v13.2 live "updated Xs ago" line. Ticks every second. Amber past 10 s, red past 30 s. */
@Composable
internal fun MarkUpdated(pos: PositionRow) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pos.mint) {
        while (true) {
            // v13.8: 4 Hz so a streamed on-chain mark reads "0.3s".
            kotlinx.coroutines.delay(250)
            now = System.currentTimeMillis()
        }
    }
    val age = liveAgeMs(pos, now)
    val fresh = markFreshness(age)
    val color = when (fresh) {
        MarkFreshness.FRESH -> P.up
        MarkFreshness.AMBER -> P.amber
        MarkFreshness.RED -> P.down
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp).semantics { contentDescription = "Mark ${updatedLabel(age)}" }) {
        Box(Modifier.size(7.dp).clip(RoundedCornerShape(50)).background(color))
        Spacer(Modifier.width(5.dp))
        Text(
            com.dirk.nightdesk.sourceAgeLabel(pos.markFeed, age) + (if (fresh == MarkFreshness.RED) " · stale" else ""),
            color = if (fresh == MarkFreshness.FRESH) P.muted else color,
            fontSize = 13.sp,
            fontWeight = if (fresh == MarkFreshness.FRESH) FontWeight.Normal else FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun fmtPx(n: Double): String = com.dirk.nightdesk.PriceText.px(n)

/** v12.3 compact connection pill: short text plus one-tap fixes instead of a big red error. */
@Composable
private fun ConnectionPill(message: String, canUseLastGood: Boolean, onUseLastGood: () -> Unit, onEditLink: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(P.amber.copy(alpha = 0.14f), RoundedCornerShape(14.dp))
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
            .background(P.card3, RoundedCornerShape(14.dp))
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
    if (raw.contains("timeout", ignoreCase = true) || raw.contains("timed out", ignoreCase = true)) return "Desk is slow to answer. Do not tap a live buy again until you see a signature or a refusal."
    return raw.take(90)
}

/** v13.4 Scout status, collapsed: one line with live count, coins/min and a red count of sources that are down. */
@Composable
private fun ScoutLine(sources: List<FeedSource>, open: Boolean, modifier: Modifier = Modifier, onToggle: () -> Unit) {
    // Inline under the header title; the whole line is the tap target.
    val sum = com.dirk.nightdesk.TapeToolbar.scout(sources)
    val down = sum.down
    val warn = sum.slow
    val dot = when {
        sources.isEmpty() -> Dim
        down > 0 -> Coral
        warn > 0 -> Amber
        else -> Mint
    }
    Row(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(6.dp))
        Text(
            if (sources.isEmpty()) "Scout" else sum.text,
            color = P.dim,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false)
        )
        if (down > 0) {
            Spacer(Modifier.width(6.dp))
            Text(sum.badge ?: "", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.clip(RoundedCornerShape(50)).background(Coral).padding(horizontal = 6.dp, vertical = 1.dp))
        } else if (warn > 0) {
            Spacer(Modifier.width(6.dp))
            Text(sum.badge ?: "", color = Color.Black, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.clip(RoundedCornerShape(50)).background(Amber).padding(horizontal = 6.dp, vertical = 1.dp))
        }
        Text(if (open) " ▾" else " ▸", color = Dim, fontSize = 13.sp)
    }
}

/** v12.1 Scout status: each source live, backing off with a countdown, down, or off. Shown when the line is tapped open. */
@Composable
private fun ScoutStatusList(sources: List<FeedSource>) {
    if (sources.isEmpty()) return
    val counting = sources.any { it.state == "backoff" && it.retryAt != null }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(counting) {
        while (counting) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(1_000)
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(P.card, RoundedCornerShape(14.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Text("Scout status", color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        sources.forEach { src ->
            val tint = when (src.state) {
                "live" -> Mint
                "backoff", "stale", "blocked" -> Amber
                "down" -> Coral
                else -> Dim
            }
            Row(Modifier.fillMaxWidth().padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(8.dp).height(8.dp).background(tint, RoundedCornerShape(4.dp)))
                Spacer(Modifier.width(8.dp))
                Text(src.label, color = P.ink, fontSize = 13.sp, modifier = Modifier.width(112.dp).padding(end = 4.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(feedSourceStateText(src, now), color = tint, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(feedSourceRateText(src), color = Dim, fontSize = 11.sp, maxLines = 1)
            }
        }
    }
}

/** v13.4 slim one-tap chip: size and slippage at a glance; tap opens the One Tap sheet. */
@Composable
private fun OneTapChip(ui: OneTapUi, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(if (ui.live) P.down.copy(alpha = 0.18f) else P.accent.copy(alpha = 0.16f))
            .border(if (ui.live) 2.dp else 1.dp, if (ui.live) P.down else P.accent.copy(alpha = 0.6f), RoundedCornerShape(50))
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text((if (ui.live && !ui.split) "LIVE " else "") + com.dirk.nightdesk.TapeToolbar.oneTapChip(ui.tapUsd, ui.slipPct), color = P.ink, fontSize = 12.5.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("  ▴", color = P.accent, fontSize = 12.sp)
    }
}

/** v13.4 Coins / Raw log toggle as two icon buttons (labels kept for TalkBack). */
@Composable
private fun IconToggle(options: List<Pair<String, String>>, selected: String, icons: Map<String, String>, onSelect: (String) -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(P.card).border(1.dp, P.line, RoundedCornerShape(50)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        options.forEach { (id, label) ->
            val on = id == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(if (on) P.accent else Color.Transparent)
                    .clickable(onClickLabel = label) { onSelect(id) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center
            ) {
                Icon(deskIcon(icons[id] ?: "list"), contentDescription = label, tint = if (on) P.onAccent else P.dim, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun ToolChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = P.ink,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (on) P.card2 else P.card)
            .border(1.dp, P.lineStrong, RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp)
    )
}

private val clockFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

private fun clock(ts: Long): String = if (ts <= 0) "—" else clockFmt.format(Instant.ofEpochMilli(ts))

/** v13 render harness for screenshot tests: the real screens with a fixed snapshot and no network. */
@Composable
internal fun DeskPreview(tab: Int, snap: DeskSnapshot, oneTap: OneTapUi? = null, scoutOpen: Boolean? = null, sheetOpen: Boolean = false, addPreview: Pair<String, com.dirk.nightdesk.CoinLookup>? = null, orderOpenFor: Pair<String, String>? = null) {
    val previewOrders = orderActionsFor(snap, oneTap?.tapUsd ?: 50.0, { _, _, _, _, _, _, _ -> }, {}, orderOpenFor)
    NightTheme {
        Scaffold(
            containerColor = P.bg,
            bottomBar = {
                Column {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(P.line))
                    NavigationBar(containerColor = P.nav, tonalElevation = 0.dp) {
                        NAV_TABS.forEachIndexed { index, (label, icon) ->
                            NavigationBarItem(
                                selected = tab == index,
                                onClick = {},
                                label = { Text(label, fontSize = 11.sp, maxLines = 1) },
                                icon = { Icon(deskIcon(icon), contentDescription = label, modifier = Modifier.size(22.dp)) },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = P.accent, selectedTextColor = P.accent,
                                    unselectedIconColor = P.dim, unselectedTextColor = P.dim,
                                    indicatorColor = P.accent.copy(alpha = 0.18f)
                                )
                            )
                        }
                    }
                }
            }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).background(P.bg)) {
                if (tab != 1) Header(status = "Connected", live = true, mode = snap.mode, liveScope = snap.liveScope)
                when (tab) {
                    0 -> BookScreen(snap, {}, { _, _ -> }, {}, {}, { _, _ -> }, oneTap, orders = previewOrders)
                    1 -> TapeScreen(
                        events = snap.events,
                        positionCapUsd = snap.positionCapUsd,
                        cooldowns = snap.cooldowns,
                        onBuy = { _, _, _ -> },
                        feedSources = snap.feedSources,
                        positionMints = snap.positions.map { it.mint }.toSet(),
                        oneTap = oneTap,
                        initialScoutOpen = scoutOpen,
                        initialSheetOpen = sheetOpen,
                        headerStatus = "Connected",
                        headerLive = true,
                        mode = snap.mode,
                        liveScope = snap.liveScope,
                        tapeQuotes = snap.tapeQuotes,
                        rawTape = snap.rawTape,
                        tapeOrders = previewOrders,
                        safetyChips = snap.safetyChips
                    )
                    2 -> if (addPreview != null) {
                        AddCoinScreen(com.dirk.nightdesk.DeskRepository.get(LocalContext.current), snap, null, oneTap, preview = addPreview)
                    } else {
                        SettingsScreen(snap) {}
                    }
                    3 -> EngineScreen(snap.strategy, snap.perf, {}, {})
                    else -> SettingsScreen(snap) {}
                }
            }
        }
    }
}

/** v13.32 a Settings sub-screen (Link, Recap, Pump) with a back row. */
@Composable
internal fun SubScreen(title: String, onBack: () -> Unit, body: @Composable () -> Unit) {
    androidx.activity.compose.BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onBack).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("‹ Settings", color = P.accent, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(12.dp))
            Text(title, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.weight(1f)) { body() }
    }
}

/** v13.11 the order UI's view of the desk. */
internal fun orderActionsFor(
    snap: DeskSnapshot,
    tapUsd: Double,
    place: (String, String, String, Double, Boolean, Int?, Double?) -> Unit,
    cancel: (String) -> Unit,
    openFor: Pair<String, String>? = null
): OrderActions = OrderActions(
    orders = snap.orders,
    liveArmed = snap.liveBook != null,
    liveTradeUsd = snap.liveTradeUsd,
    tapUsd = tapUsd,
    stopLossPct = snap.stopLossPct,
    place = place,
    cancel = cancel,
    openFor = openFor
)

