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

/** v13.2: Home with open position cards showing the live "updated" line. Skips without a fixture. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w384dp-h832dp-xxhdpi")
class V132ShotsTest {
    @Test fun renderPositions() {
        val fixture = File(System.getenv("ND_STATE_132") ?: "/tmp/state132.json")
        val out = File(System.getenv("ND_SHOTS_132") ?: "/workspace/v132-shots/android")
        assumeTrue(fixture.exists())
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK, ThemePref.LIGHT)) {
            ThemeState.pref = pref
            val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
            val activity = controller.get()
            activity.setContent { DeskPreview(0, snap) }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(200)
            shadowOf(Looper.getMainLooper()).idle()
            val root = activity.window.decorView
            val bmp = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            root.draw(android.graphics.Canvas(bmp))
            File(out, "${pref.name.lowercase()}-positions.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            controller.pause().stop().destroy()
        }
        ThemeState.pref = ThemePref.DARK
    }
}
