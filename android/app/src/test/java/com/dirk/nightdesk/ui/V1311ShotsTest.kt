package com.dirk.nightdesk.ui

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.dirk.nightdesk.parseDeskPayload
import java.io.File
import java.util.TimeZone
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** v13.11: order ticket on a position, the Orders list, and a limit buy ticket on a Tape card. Skips without ND_STATE_1311. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w384dp-h832dp-xxhdpi")
class V1311ShotsTest {
    private fun render(stateEnv: String, prefix: String, tabs: List<Pair<Int, String>>, openFor: (com.dirk.nightdesk.DeskSnapshot) -> Pair<String, String>?) {
        val fixture = File(System.getenv(stateEnv) ?: "/nonexistent")
        val out = File(System.getenv("ND_SHOTS_1311") ?: "/workspace/v1311-shots/android")
        assumeTrue(fixture.exists())
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        val live = snap.mode == "live"
        val tap = com.dirk.nightdesk.OneTap.effectiveTapUsd(snap.mode, (System.getenv("ND_TAP_USD") ?: "1223").toDouble(), snap.liveTradeUsd)
        val ui = OneTapUi(
            tapUsd = tap,
            capUsd = snap.positionCapUsd,
            maxUsd = kotlin.math.max(snap.positionCapUsd, snap.cashUsd),
            slipPct = kotlin.math.round(snap.maxEntrySlippage * 10_000.0) / 100.0,
            stopPct = snap.stopLossPct,
            tapping = emptySet(),
            openCount = snap.positions.size,
            onBuy = { _, _ -> }, onSell = { _, _ -> }, onSellAll = {}, onTapUsd = {}, onSlip = {},
            live = live,
            liveTrailPct = snap.liveTrailPct,
            split = snap.liveBook != null,
            aiLive = snap.liveBook?.manualOnly == false,
            liveTapUsd = com.dirk.nightdesk.LiveTap.size(snap),
            liveBlock = com.dirk.nightdesk.LiveTap.block(snap),
            liveHeld = com.dirk.nightdesk.LiveTap.held(snap),
            paperHeld = snap.positions.associate { it.mint to it.pnlUsd }
        )
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK)) {
            for ((tab, name) in tabs) {
                ThemeState.pref = pref
                val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
                val activity = controller.get()
                activity.setContent { DeskPreview(tab, snap, ui, scoutOpen = false, sheetOpen = false, orderOpenFor = openFor(snap)) }
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(200)
                shadowOf(Looper.getMainLooper()).idle()
                val root = activity.window.decorView
                val bmp = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bmp))
                File(out, "$prefix-${pref.name.lowercase()}-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                controller.pause().stop().destroy()
            }
        }
        ThemeState.pref = ThemePref.DARK
    }

    @Test @Config(qualifiers = "w384dp-h3000dp-xxhdpi")
    fun book() = render("ND_STATE_1311", "orders", listOf(0 to "book")) { snap ->
        snap.positions.firstOrNull()?.let { it.mint to "take_profit" }
    }

    @Test @Config(qualifiers = "w384dp-h1500dp-xxhdpi")
    fun tape() = render("ND_STATE_1311", "orders", listOf(1 to "tape")) { snap ->
        val held = snap.positions.map { it.mint }.toSet()
        val coins = com.dirk.nightdesk.sortCoins(com.dirk.nightdesk.coinCards(snap.events, held, quotes = snap.tapeQuotes), com.dirk.nightdesk.TapeSort.VOLUME)
        coins.firstOrNull { it.verdict != com.dirk.nightdesk.Verdict.OPEN }?.let { it.mint to "limit_buy" }
    }

    /** The Orders list on its own (it sits below the positions on the Book tab). */
    @Test @Config(qualifiers = "w384dp-h900dp-xxhdpi")
    fun ordersList() {
        val fixture = File(System.getenv("ND_STATE_1311") ?: "/nonexistent")
        assumeTrue(fixture.exists())
        val out = File(System.getenv("ND_SHOTS_1311") ?: "/workspace/v1311-shots/android").apply { mkdirs() }
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        ThemeState.pref = ThemePref.DARK
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = controller.get()
        activity.setContent {
            NightTheme {
                Column(Modifier.fillMaxSize().background(P.bg).padding(16.dp)) {
                    OrdersCard(orderActionsFor(snap, 50.0, { _, _, _, _, _, _, _ -> }, {}))
                }
            }
        }
        shadowOf(Looper.getMainLooper()).idle()
        Thread.sleep(200)
        shadowOf(Looper.getMainLooper()).idle()
        val root = activity.window.decorView
        val bmp = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        root.draw(android.graphics.Canvas(bmp))
        File(out, "orders-dark-open-orders.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        controller.pause().stop().destroy()
    }
}
