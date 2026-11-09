package com.dirk.nightdesk

import android.app.Application
import android.os.StrictMode

class NightDeskApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            // A main-thread socket is a crash on a phone (v13.18 Pump Watch). Debug and the
            // instrumented gate die the same way instead of logging and continuing.
            StrictMode.setThreadPolicy(
                StrictMode.ThreadPolicy.Builder()
                    .detectNetwork()
                    .penaltyLog()
                    .penaltyDeath()
                    .build()
            )
        }
        runCatching { com.dirk.nightdesk.pump.alerts.FirebaseGate.ready(this) }
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { CrashLog.write(this, thread, error) }
            previous?.uncaughtException(thread, error)
        }
    }
}
