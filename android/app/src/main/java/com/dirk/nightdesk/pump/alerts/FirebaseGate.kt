package com.dirk.nightdesk.pump.alerts

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

/**
 * Firebase starts only when the google-services values are present.
 * The init provider is removed from the manifest, so a missing config cannot
 * crash process start. Alerts then stay on [LocalAlertEngine].
 *
 * A message delivered to [FcmService] is what reaches the app after it has been
 * swiped away. That path needs a real google-services.json and a device token;
 * this build does not claim to have exercised it.
 */
object FirebaseGate {
    fun ready(context: Context): Boolean {
        if (FirebaseApp.getApps(context).isNotEmpty()) return true
        val appId = res(context, "google_app_id") ?: return false
        val apiKey = res(context, "google_api_key") ?: return false
        val project = res(context, "project_id") ?: return false
        val sender = res(context, "gcm_defaultSenderId") ?: return false
        return runCatching {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setApplicationId(appId)
                    .setApiKey(apiKey)
                    .setProjectId(project)
                    .setGcmSenderId(sender)
                    .build()
            )
            true
        }.getOrDefault(false)
    }

    private fun res(context: Context, name: String): String? {
        val id = context.resources.getIdentifier(name, "string", context.packageName)
        if (id == 0) return null
        return runCatching { context.getString(id) }.getOrNull()?.takeIf { it.isNotBlank() }
    }
}
