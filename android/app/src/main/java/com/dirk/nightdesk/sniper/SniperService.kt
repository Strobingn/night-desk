package com.dirk.nightdesk.sniper

import android.annotation.TargetApi
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.MainActivity
import com.dirk.nightdesk.isForegroundStartBlocked
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Foreground worker for the graduation sniper. The web tab can close; this
 * notification stays up and opens the one-tap approve screen when a live buy is ready.
 * It never asks the server to build a second transaction.
 */
class SniperService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Graduation sniper", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
        promote("Watching", "Waiting for a curve near graduation", openApp())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promote("Watching", "Graduation sniper is on", openApp())
        if (loop == null) {
            loop = scope.launch {
                while (isActive) {
                    runCatching { refresh() }
                    delay(1_000)
                }
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        loop?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun refresh() {
        val link = DeskRepository.get(this).linkSnapshot()
        if (link.baseUrl.isBlank()) {
            notify("Watching", "Desk URL is not set", openApp())
            return
        }
        val body = get(link.baseUrl.trimEnd('/') + "/api/pump/sniper", link.token) ?: return
        val jobs = body.optJSONArray("jobs") ?: return
        if (jobs.length() == 0) {
            notify("Watching", "No coin armed", openApp())
            return
        }
        val job = sentJob(jobs) ?: jobs.getJSONObject(0)
        val phase = job.optString("phase", "watching")
        val mint = job.optString("mint", "")
        val label = job.optString("poolClass", "")
        val text = sniperNotification(phase, mint, label.ifBlank { null }, job.optString("reason", ""))
        notify(phase, text, tapFor(job, link.baseUrl, link.token))
    }

    /** A live buy on any armed mint, not only the oldest watching job. */
    private fun sentJob(jobs: JSONArray): JSONObject? {
        for (i in 0 until jobs.length()) {
            val job = jobs.getJSONObject(i)
            if (job.optString("phase") == "sent" && !job.optBoolean("simulateOnly", true) && job.optString("unsignedTx").isNotBlank()) {
                return job
            }
        }
        return null
    }

    /**
     * Tapping the ongoing notification opens the approve screen once a live buy is sent.
     * A service cannot start that activity itself on Android 10+.
     */
    private fun tapFor(job: JSONObject, baseUrl: String, token: String): PendingIntent {
        val tx = job.optString("unsignedTx", "")
        val simulate = job.optBoolean("simulateOnly", true)
        if (job.optString("phase") != "sent" || simulate || tx.isBlank()) return openApp()
        val approve = SniperApproveActivity.intent(
            this,
            job.optString("mint", ""),
            tx,
            baseUrl,
            token,
            job.optString("wallet", ""),
            job.optString("solLamports", "0"),
            tradeCap(baseUrl, token),
            simulate
        )
        approve.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(this, 3, approve, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun notify(title: String, text: String, tap: PendingIntent) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(ONGOING_ID, ongoing(title, text, tap))
    }

    private fun promote(title: String, text: String, tap: PendingIntent) {
        val notification = ongoing(title, text, tap)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ONGOING_ID, notification)
        }
    }

    private fun ongoing(title: String, text: String, tap: PendingIntent): Notification {
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Sniper · $title")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(tap)
            .build()
    }

    private fun openApp(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @TargetApi(35)
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onTimeout(startId: Int) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        private const val CHANNEL = "night_desk_sniper"
        private const val ONGOING_ID = 4722

        fun start(context: Context) {
            val intent = Intent(context, SniperService::class.java)
            try {
                context.startForegroundService(intent)
            } catch (error: Exception) {
                if (!isForegroundStartBlocked(error)) throw error
            }
        }
    }
}

/** Ongoing notification line. Non-canonical pools are named and are not buys. */
fun sniperNotification(phase: String, mint: String, poolClass: String?, reason: String): String {
    val short = if (mint.length > 8) mint.take(4) + "…" + mint.takeLast(4) else mint.ifBlank { "coin" }
    val label = if (poolClass == "non-canonical") " · non-canonical, not sniped" else ""
    val why = if (reason.isBlank()) "" else " · $reason"
    return "$phase $short$label$why"
}

private fun tradeCap(baseUrl: String, token: String): String {
    val body = get(baseUrl.trimEnd('/') + "/api/pump/status", token)
    val raw = body?.optJSONObject("caps")?.optString("tradeLamports", "").orEmpty()
    return if (raw.isNotBlank() && raw.all { it.isDigit() }) raw else SniperApproveActivity.DEFAULT_CAP
}

private fun get(url: String, token: String): JSONObject? {
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 4_000
        readTimeout = 4_000
        if (token.isNotBlank()) setRequestProperty("X-Desk-Token", token)
    }
    return try {
        if (conn.responseCode !in 200..299) null
        else JSONObject(conn.inputStream.bufferedReader().readText())
    } finally {
        conn.disconnect()
    }
}
