package com.dirk.nightdesk.pump

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.math.BigInteger
import java.util.concurrent.TimeUnit

/** True when the watched curve has reached the target market cap. */
fun shouldAlert(marketCapLamports: BigInteger, targetLamports: BigInteger): Boolean {
    return targetLamports.signum() > 0 && marketCapLamports >= targetLamports
}

fun priceAlertWorkName(mint: String) = "pump-price-$mint"

/**
 * Background price watch. Periodic WorkManager work (15 minute floor) posts a
 * notification. It does not start a foreground service and it does not trade.
 */
class PumpPriceAlertWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val mint = inputData.getString(KEY_MINT) ?: return Result.failure()
        val target = inputData.getString(KEY_TARGET)?.toBigIntegerOrNull() ?: return Result.failure()
        val base = inputData.getString(KEY_BASE).orEmpty()
        val token = inputData.getString(KEY_TOKEN).orEmpty()
        if (base.isBlank()) return Result.retry()
        val curve = PumpApi().fetchCurve(base, token, mint) ?: return Result.retry()
        if (!shouldAlert(curve.marketCapLamports, target)) return Result.success()
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val mark = "$mint:$target"
        if (prefs.getBoolean(mark, false)) return Result.success()
        prefs.edit().putBoolean(mark, true).apply()
        notify(applicationContext, mint, CurveMath.formatSol(curve.marketCapLamports))
        return Result.success()
    }

    companion object {
        const val KEY_MINT = "mint"
        const val KEY_TARGET = "target"
        const val KEY_BASE = "base"
        const val KEY_TOKEN = "token"
        private const val PREFS = "pump_price_alerts"
        private const val CHANNEL = "pump-price"

        fun enqueue(context: Context, mint: String, targetLamports: String, baseUrl: String, token: String) {
            val data = workDataOf(KEY_MINT to mint, KEY_TARGET to targetLamports, KEY_BASE to baseUrl, KEY_TOKEN to token)
            val request = PeriodicWorkRequestBuilder<PumpPriceAlertWorker>(15, TimeUnit.MINUTES)
                .setInputData(data)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                priceAlertWorkName(mint),
                ExistingPeriodicWorkPolicy.UPDATE,
                request
            )
        }

        private fun notify(context: Context, mint: String, mcapSol: String) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Pump price alerts", NotificationManager.IMPORTANCE_DEFAULT))
            val notification = Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("Curve watch")
                .setContentText("${mint.take(4)}… market cap $mcapSol SOL")
                .build()
            manager.notify(mint.hashCode(), notification)
        }
    }
}
