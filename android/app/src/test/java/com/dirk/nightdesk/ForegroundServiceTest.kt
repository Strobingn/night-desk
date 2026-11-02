package com.dirk.nightdesk

import android.app.ForegroundServiceStartNotAllowedException
import android.app.InvalidForegroundServiceTypeException
import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

class ForegroundServicePolicyTest {
    @Test
    fun manifestIsSpecialUseAndNotDataSync() {
        val manifest = readProjectFile("src/main/AndroidManifest.xml")
        assertFalse(manifest.contains("dataSync"))
        assertFalse(manifest.contains("FOREGROUND_SERVICE_DATA_SYNC"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"specialUse\""))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"))
        assertTrue(manifest.contains("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"))
        assertTrue(manifest.contains("Live trading desk connection for the paper book and price feed."))
        assertTrue(manifest.contains("android.intent.action.SEND"))
        assertTrue(manifest.contains("android:mimeType=\"text/plain\""))
        val gradle = readProjectFile("build.gradle.kts")
        assertTrue(gradle.contains("versionCode = 24"))
        assertTrue(gradle.contains("versionName = \"v13.8\""))
    }

    @Test
    fun timeoutStopsTheServiceBeforeAnyTeardown() {
        val order = mutableListOf<String>()
        TimeoutHalt.run(
            stopForeground = { order += "stopForeground" },
            stopSelf = { order += "stopSelf" },
            afterStopped = { order += "teardown" }
        )
        assertEquals(listOf("stopForeground", "stopSelf", "teardown"), order)
    }

    private fun readProjectFile(name: String): String {
        val candidates = listOf(File(name), File("app/$name"), File("android/app/$name"))
        val file = candidates.firstOrNull { it.isFile } ?: error("missing $name from ${File(".").absolutePath}")
        return file.readText()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DeskServiceTimeoutTest {
    @Test
    fun oneArgTimeoutCallsStopSelf() {
        val service = Robolectric.buildService(DeskConnectionService::class.java).create().get()
        service.onTimeout(4)
        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun twoArgTimeoutCallsStopSelf() {
        val service = Robolectric.buildService(DeskConnectionService::class.java).create().get()
        service.onTimeout(4, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun blockedForegroundStartsAreRecognized() {
        assertTrue(isForegroundStartBlocked(ForegroundServiceStartNotAllowedException("background")))
        assertTrue(isForegroundStartBlocked(InvalidForegroundServiceTypeException("type")))
        assertTrue(isForegroundStartBlocked(RuntimeException("wrapped", ForegroundServiceStartNotAllowedException("background"))))
        assertFalse(isForegroundStartBlocked(IllegalStateException("other")))
    }
}
