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

/** v13.1: the Tape at Galaxy S24 Ultra size (384×832 dp), dark and light. Skips without a state fixture. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w384dp-h832dp-xxhdpi")
class V131ShotsTest {
    @Test fun renderTape() {
        val fixture = File(System.getenv("ND_STATE") ?: "/tmp/state.json")
        val out = File(System.getenv("ND_SHOTS_131") ?: "/workspace/v131-shots/android")
        assumeTrue(fixture.exists())
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
        val snap = parseDeskPayload(fixture.readText()) ?: error("fixture did not parse")
        out.mkdirs()
        for (pref in listOf(ThemePref.DARK, ThemePref.LIGHT)) {
            ThemeState.pref = pref
            for ((tab, name) in listOf(1 to "tape", 4 to "settings")) {
                val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
                val activity = controller.get()
                activity.setContent { DeskPreview(tab, snap) }
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(200)
                shadowOf(Looper.getMainLooper()).idle()
                val root = activity.window.decorView
                val bmp = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bmp))
                File(out, "${pref.name.lowercase()}-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                controller.pause().stop().destroy()
            }
        }
        ThemeState.pref = ThemePref.DARK
    }
}
