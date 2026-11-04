package com.dirk.nightdesk.pump.alerts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.dirk.nightdesk.MainActivity

/**
 * Posts a desk alert. Full-screen uses a full-screen intent only when
 * NotificationManager.canUseFullScreenIntent() allows it (Android 14+).
 * Otherwise the same alert is a heads-up on the high-importance channel.
 */
object AlertNotifier {
    const val CHANNEL_SILENT = "desk_alerts_silent"
    const val CHANNEL_SOUND = "desk_alerts_sound"
    const val CHANNEL_FULLSCREEN = "desk_alerts_fullscreen"

    fun show(context: Context, title: String, body: String, delivery: String, id: Int = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(manager)
        val mode = FullScreenGate.resolve(Build.VERSION.SDK_INT, FullScreenGate.canUse(context), delivery)
        val channel = when (mode) {
            "silent" -> CHANNEL_SILENT
            "fullscreen" -> CHANNEL_FULLSCREEN
            else -> CHANNEL_SOUND
        }
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setSilent(mode == "silent")
            .setPriority(if (mode == "silent") NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (mode == "fullscreen") NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_STATUS)
        if (mode == "fullscreen") builder.setFullScreenIntent(open, true)
        manager.notify(id, builder.build())
    }

    private fun ensureChannels(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < 26) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_SILENT, "Desk alerts (silent)", NotificationManager.IMPORTANCE_LOW).apply {
            setSound(null, null)
            enableVibration(false)
        })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_SOUND, "Desk alerts", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_FULLSCREEN, "Desk alerts (full screen)", NotificationManager.IMPORTANCE_HIGH))
    }
}
