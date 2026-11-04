package com.dirk.nightdesk.pump.alerts

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

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
            message.notification?.title ?: "Night Desk",
            body,
            delivery
        )
    }

    override fun onNewToken(token: String) {
        getSharedPreferences("desk_alerts", MODE_PRIVATE).edit().putString("fcm_token", token).apply()
    }
}
