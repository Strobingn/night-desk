package com.dirk.nightdesk

import android.app.Application

class NightDeskApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { CrashLog.write(this, thread, error) }
            previous?.uncaughtException(thread, error)
        }
    }
}
