package com.dirk.nightdesk

import android.app.ForegroundServiceStartNotAllowedException
import android.app.ForegroundServiceTypeException
import android.os.Build

/**
 * Android 15 delivers the dataSync quota on `onTimeout(int, int)`.
 * stopForeground and stopSelf have to run on the calling thread before any
 * socket or scheduler work, or the process is killed.
 */
internal object TimeoutHalt {
    fun run(stopForeground: () -> Unit, stopSelf: () -> Unit, afterStopped: () -> Unit) {
        stopForeground()
        stopSelf()
        afterStopped()
    }
}

internal fun isForegroundStartBlocked(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && current is ForegroundServiceStartNotAllowedException) {
            return true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && current is ForegroundServiceTypeException) {
            return true
        }
        current = current.cause
    }
    return false
}
