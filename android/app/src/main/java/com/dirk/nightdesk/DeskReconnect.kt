package com.dirk.nightdesk

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

/**
 * Reopens the desk socket after a foreground-service timeout.
 * This does not call startForegroundService. Android 12+ rejects that from the background.
 */
class DeskReconnectWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        try {
            DeskRepository.get(applicationContext).reconnectAfterTimeout()
            return Result.success()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            CrashLog.write(applicationContext, Thread.currentThread(), error)
            return Result.retry()
        }
    }
}

/** Alarm fallback when WorkManager cannot be scheduled. */
class DeskReconnectReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val pending = goAsync()
        Thread {
            try {
                DeskRepository.get(context.applicationContext).boot()
            } finally {
                pending.finish()
            }
        }.start()
    }
}

internal object DeskReconnect {
    private const val WORK = "desk-reconnect"

    fun enqueue(context: Context) {
        val app = context.applicationContext
        val scheduled = runCatching {
            val request = OneTimeWorkRequestBuilder<DeskReconnectWorker>()
                .setInitialDelay(5, TimeUnit.SECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(app).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
        }
        if (scheduled.isFailure) scheduleAlarm(app)
    }

    private fun scheduleAlarm(context: Context) {
        val alarm = context.getSystemService(AlarmManager::class.java) ?: return
        val pending = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, DeskReconnectReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val at = SystemClock.elapsedRealtime() + 5_000L
        runCatching { alarm.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending) }
            .onFailure { runCatching { alarm.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending) } }
    }
}
