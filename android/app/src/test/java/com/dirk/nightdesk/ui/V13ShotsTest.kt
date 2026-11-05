package com.dirk.nightdesk.ui

import android.graphics.Bitmap
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.dirk.nightdesk.parseDeskPayload
import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import android.os.Looper

/** Renders Home, Tape and Settings in dark and light to PNGs. Skips unless a state fixture is given. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h915dp-xxhdpi")
class V13ShotsTest {
    @Test fun renderScreens() {
        val fixture = File(System.getProperty("nd.state") ?: System.getenv("ND_STATE") ?: "/tmp/state.json")
        val out = File(System.getenv("ND_SHOTS") ?: "/workspace/v13-shots/android")
        assumeTrue(fixture.exists())
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK, ThemePref.LIGHT)) {
            ThemeState.pref = pref
            for ((tab, name) in listOf(0 to "1-home", 1 to "2-tape", 4 to "3-settings")) {
                val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
                val activity = controller.get()
                activity.setContent { DeskPreview(tab, snap) }
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(200)
                shadowOf(Looper.getMainLooper()).idle()
                val root: View = activity.window.decorView
                val w = root.width.takeIf { it > 0 } ?: 1236
                val h = root.height.takeIf { it > 0 } ?: 2745
                val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bmp))
                File(out, "${pref.name.lowercase()}-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                controller.pause().stop().destroy()
            }
        }
        ThemeState.pref = ThemePref.DARK
    }
}
