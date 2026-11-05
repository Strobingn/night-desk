package com.dirk.nightdesk.ui

import android.graphics.Bitmap
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.dirk.nightdesk.CoinLookup
import com.dirk.nightdesk.parseDeskPayload
import com.dirk.nightdesk.parseLookup
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
 * v13.6: Add coin by ticker (single match card and multi-match pick list) and the Book one-tap
 * hint naming the cap. ND_STATE_136 is the real desk state; ND_LOOKUP_136_SINGLE / _MULTI are
 * real /api/lookup replies from the v13.6 desk code. Skips without fixtures.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w384dp-h1400dp-xxhdpi")
class V136ShotsTest {
    private fun render(name: String, tab: Int, add: Pair<String, CoinLookup>?) {
        val fixture = File(System.getenv("ND_STATE_136") ?: "/nonexistent")
        val out = File(System.getenv("ND_SHOTS_136") ?: "/workspace/v136-shots/android")
        assumeTrue(fixture.exists())
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        val tap = (System.getenv("ND_TAP_USD") ?: "20").toDouble()
        val ui = OneTapUi(
            tapUsd = tap,
            capUsd = snap.positionCapUsd,
            maxUsd = kotlin.math.max(snap.positionCapUsd, snap.cashUsd),
            slipPct = kotlin.math.round(snap.maxEntrySlippage * 10_000.0) / 100.0,
            stopPct = snap.stopLossPct,
            tapping = emptySet(),
            openCount = snap.positions.size,
            onBuy = { _, _ -> }, onSell = { _, _ -> }, onSellAll = {}, onTapUsd = {}, onSlip = {},
            live = snap.mode == "live",
            liveTrailPct = snap.liveTrailPct,
            capLine = snap.capLine
        )
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK, ThemePref.LIGHT)) {
            ThemeState.pref = pref
            val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
            val activity = controller.get()
            activity.setContent { DeskPreview(tab, snap, ui, scoutOpen = false, addPreview = add) }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(200)
            shadowOf(Looper.getMainLooper()).idle()
            val root = activity.window.decorView
            val bmp = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            root.draw(android.graphics.Canvas(bmp))
            File(out, "${pref.name.lowercase()}-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            controller.pause().stop().destroy()
        }
        ThemeState.pref = ThemePref.DARK
    }

    private fun lookup(env: String): CoinLookup? = System.getenv(env)?.let { File(it) }?.takeIf { it.exists() }?.let { parseLookup(it.readText()) }

    @Test fun tickerSingle() {
        val found = lookup("ND_LOOKUP_136_SINGLE")
        assumeTrue(found != null)
        render("addcoin-ticker-single", 2, (System.getenv("ND_Q_SINGLE") ?: "qtfalcn") to found!!)
    }

    @Test fun tickerMulti() {
        val found = lookup("ND_LOOKUP_136_MULTI")
        assumeTrue(found != null)
        render("addcoin-ticker-multi", 2, (System.getenv("ND_Q_MULTI") ?: "TAZ") to found!!)
    }

    @Test fun bookOneTapCapHint() = render("book-onetap-cap", 0, null)
}
