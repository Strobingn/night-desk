package com.dirk.nightdesk

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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keeps the desk socket alive after the activity is backgrounded.
 * The ongoing notification shows equity and open positions. A near miss
 * posts a separate alert with a one-tap Buy.
 */
class DeskConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        if (error is CancellationException) return@CoroutineExceptionHandler
        CrashLog.write(this, Thread.currentThread(), error)
    })
    private var lastNearId: String? = null
    private var alertsPrimed = false
    private val seenAlerts = HashSet<String>()
    private val halted = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ONGOING, "Night Desk", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERT, "Near misses", NotificationManager.IMPORTANCE_HIGH)
        )
        promote()
        val desk = DeskRepository.get(this)
        desk.boot()
        scope.launch {
            desk.snapshot.collect { snap ->
                val open = snap?.positions?.size ?: 0
                val equity = formatUsd(snap?.equityUsd)
                val managerNow = getSystemService(NotificationManager::class.java)
                runCatching { managerNow.notify(ONGOING_ID, ongoing(equity, "$open open")) }
                val near = snap?.advice?.firstOrNull { it.stance == "near-miss" && !it.mint.isNullOrBlank() }
                if (snap?.notifyNearMiss != false && near != null && near.id != lastNearId) {
                    lastNearId = near.id
                    runCatching { managerNow.notify(near.id.hashCode(), nearMiss(near)) }
                }
                if (snap != null) notifyBook(managerNow, snap)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (halted.get()) {
            TimeoutHalt.run(
                stopForeground = { stopForeground(STOP_FOREGROUND_REMOVE) },
                stopSelf = { stopSelf() },
                afterStopped = {}
            )
            return START_NOT_STICKY
        }
        promote()
        return START_STICKY
    }

    override fun onTimeout(startId: Int) {
        haltForTimeout()
    }

    @TargetApi(35)
    override fun onTimeout(startId: Int, fgsType: Int) {
        haltForTimeout()
    }

    private fun haltForTimeout() {
        if (!halted.compareAndSet(false, true)) return
        val app = applicationContext
        TimeoutHalt.run(
            stopForeground = { stopForeground(STOP_FOREGROUND_REMOVE) },
            stopSelf = { stopSelf() },
            afterStopped = {
                Thread({
                    runCatching { DeskRepository.get(app).releaseForTimeout() }
                    runCatching { DeskReconnect.enqueue(app) }
                }, "desk-fgs-stop").start()
            }
        )
    }

    private fun promote() {
        val starting = ongoing("Connecting", "Waiting for the book")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(ONGOING_ID, starting, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(ONGOING_ID, starting)
            }
        } catch (error: Exception) {
            if (isForegroundStartBlocked(error)) {
                if (halted.compareAndSet(false, true)) {
                    runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
                    stopSelf()
                }
                DeskRepository.get(this).boot()
                DeskReconnect.enqueue(this)
            } else {
                CrashLog.write(this, Thread.currentThread(), error)
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notifyBook(manager: NotificationManager, snap: DeskSnapshot) {
        if (!alertsPrimed) {
            alertsPrimed = true
            return
        }
        if (snap.notifyFills || snap.notifyStops) {
            for (event in snap.events.takeLast(40)) {
                val fill = snap.notifyFills && event.kind == "fill"
                val stop = snap.notifyStops && (event.code == "STOP_LOSS" || event.code == "TRAIL_STOP")
                if (!fill && !stop) continue
                if (!seenAlerts.add(event.id)) continue
                runCatching {
                    manager.notify(
                        event.id.hashCode(),
                        Notification.Builder(this, CHANNEL_ALERT)
                            .setSmallIcon(android.R.drawable.stat_notify_chat)
                            .setContentTitle(if (stop) "Stop" else "Fill")
                            .setContentText(event.message)
                            .setAutoCancel(true)
                            .setContentIntent(openApp())
                            .build()
                    )
                }
            }
        }
        if (snap.pnlAlertPct > 0) {
            for (pos in snap.positions) {
                val move = kotlin.math.abs(pos.pnlPct) * 100.0
                val key = pos.mint + ":" + snap.pnlAlertPct.toInt()
                if (move >= snap.pnlAlertPct && seenAlerts.add(key)) {
                    runCatching {
                        manager.notify(
                            key.hashCode(),
                            Notification.Builder(this, CHANNEL_ALERT)
                                .setSmallIcon(android.R.drawable.stat_notify_chat)
                                .setContentTitle("${pos.symbol} moved ${"%.1f".format(move)}%")
                                .setContentText("PnL alert threshold is ${snap.pnlAlertPct.toInt()}%.")
                                .setAutoCancel(true)
                                .setContentIntent(openApp())
                                .build()
                        )
                    }
                }
            }
        }
    }

    private fun ongoing(title: String, text: String): Notification {
        return Notification.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Night Desk · $title")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .build()
    }

    private fun nearMiss(note: AdviceNote): Notification {
        val mint = note.mint.orEmpty()
        val buy = PendingIntent.getBroadcast(
            this,
            mint.hashCode(),
            Intent(this, DeskBuyReceiver::class.java).apply {
                putExtra(DeskBuyReceiver.EXTRA_MINT, mint)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("Near miss — your call")
            .setContentText(note.text)
            .setStyle(Notification.BigTextStyle().bigText(note.text))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .addAction(Notification.Action.Builder(null, "Buy", buy).build())
            .build()
    }

    private fun openApp(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    companion object {
        private const val CHANNEL_ONGOING = "night_desk"
        private const val CHANNEL_ALERT = "night_desk_alerts"
        private const val ONGOING_ID = 4721

        fun start(context: Context) {
            val intent = Intent(context, DeskConnectionService::class.java)
            try {
                context.startForegroundService(intent)
            } catch (error: Exception) {
                if (isForegroundStartBlocked(error)) {
                    DeskRepository.get(context).boot()
                    DeskReconnect.enqueue(context)
                } else {
                    CrashLog.write(context, Thread.currentThread(), error)
                }
            }
        }
    }
}
