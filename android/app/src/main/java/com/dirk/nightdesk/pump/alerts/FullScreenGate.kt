package com.dirk.nightdesk.pump.alerts

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Android 14+ requires a runtime full-screen-intent grant.
 * When it is missing, alerts fall back to a heads-up notification.
 */
object FullScreenGate {
    const val MANAGE_ACTION = Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT

    fun resolve(sdkInt: Int, canUseFullScreenIntent: Boolean, requested: String): String {
        if (requested != "fullscreen") return requested
        return if (sdkInt >= 34 && !canUseFullScreenIntent) "heads-up" else "fullscreen"
    }

    fun canUse(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        return manager.canUseFullScreenIntent()
    }

    /** Settings panel for this package. The data URI is `package:<applicationId>`. */
    fun manageIntent(context: Context): Intent {
        return Intent(MANAGE_ACTION).setData(Uri.parse("package:${context.packageName}"))
    }
}
