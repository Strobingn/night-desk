package com.dirk.nightdesk.ui

import android.graphics.Bitmap
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

/**
 * v13.7: "Live: manual only · AI: paper" — the real desk state and an illustrative armed state.
 * ND_STATE_137 is the real desk state; ND_STATE_137_ARMED an illustrative armed state. Skips without fixtures.
 * illustrative LIVE-on state. Skips without fixtures.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w384dp-h832dp-xxhdpi")
class V137ShotsTest {
    private fun render(stateEnv: String, prefix: String, tabs: List<Pair<Int, String>>) {
        val fixture = File(System.getenv(stateEnv) ?: "/nonexistent")
        val out = File(System.getenv("ND_SHOTS_137") ?: "/workspace/v137-shots/android")
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
            aiLive = snap.liveBook?.manualOnly == false
        )
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK, ThemePref.LIGHT)) {
            for ((tab, name) in tabs) {
                ThemeState.pref = pref
                val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
                val activity = controller.get()
                activity.setContent { DeskPreview(tab, snap, ui, scoutOpen = false, sheetOpen = tab == 1) }
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

    @Test @Config(qualifiers = "w384dp-h1500dp-xxhdpi")
    fun realStateSettingsTall() = render("ND_STATE_137", "real", listOf(2 to "settings-tall"))

    @Test @Config(qualifiers = "w384dp-h1800dp-xxhdpi")
    fun armedPreviewBookAndSettings() = render("ND_STATE_137_ARMED", "preview-armed", listOf(0 to "book", 2 to "settings"))
}
