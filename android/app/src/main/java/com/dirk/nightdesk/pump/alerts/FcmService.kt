package com.dirk.nightdesk.pump.alerts

import android.content.Context
import com.dirk.nightdesk.DeskRepository
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Receives FCM data messages, including after the app is swiped away,
 * once Firebase is configured. Without google-services.json this service
 * is never started and [LocalAlertEngine] is the fallback.
 */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val body = data["body"] ?: message.notification?.body ?: return
        val delivery = data["delivery"] ?: "sound"
        AlertNotifier.show(
            this,
            data["title"] ?: message.notification?.title ?: "Night Desk",
            body,
            delivery
        )
    }

    override fun onNewToken(token: String) {
        FcmTokenSync.remember(this, token)
        FcmTokenSync.upload(this, token)
    }
}

/** Registers the device token with the desk so live alerts can be pushed. */
object FcmTokenSync {
    fun remember(context: Context, token: String) {
        context.getSharedPreferences("desk_alerts", Context.MODE_PRIVATE).edit().putString("fcm_token", token).apply()
    }

    fun upload(context: Context, token: String) {
        if (token.isBlank()) return
        val app = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            DeskRepository.get(app).pumpPost("/api/pump/push/fcm", JSONObject().put("token", token).toString())
        }
    }

    /** Current token, including one issued before this process registered [FcmService.onNewToken]. */
    fun sync(context: Context) {
        if (!FirebaseGate.ready(context)) return
        val app = context.applicationContext
        runCatching {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                remember(app, token)
                upload(app, token)
            }
        }
    }
}
