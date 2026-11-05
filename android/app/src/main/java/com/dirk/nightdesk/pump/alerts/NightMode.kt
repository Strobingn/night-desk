package com.dirk.nightdesk.pump.alerts

import android.app.Activity
import android.content.Context
import android.view.WindowManager
import com.dirk.nightdesk.ui.ThemeState
import java.util.Calendar

data class NightSchedule(
    val enabled: Boolean = true,
    val startMin: Int = 22 * 60,
    val endMin: Int = 7 * 60,
    val brightness: Float = 0.55f
)

/**
 * Dark theme plus a lower screen brightness while the schedule is active.
 * An overnight window (22:00–07:00) wraps past midnight.
 */
object NightMode {
    private const val FILE = "desk_alerts"
    private const val ENABLED = "night_enabled"
    private const val START = "night_start"
    private const val END = "night_end"
    private const val BRIGHT = "night_brightness"

    fun isNight(schedule: NightSchedule, minutes: Int): Boolean {
        if (!schedule.enabled) return false
        val start = schedule.startMin.coerceIn(0, 24 * 60 - 1)
        val end = schedule.endMin.coerceIn(0, 24 * 60 - 1)
        if (start == end) return true
        if (start < end) return minutes in start until end
        return minutes >= start || minutes < end
    }

    fun isNight(schedule: NightSchedule, hour: Int, minute: Int): Boolean = isNight(schedule, hour * 60 + minute)

    fun load(context: Context): NightSchedule {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return NightSchedule(
            enabled = prefs.getBoolean(ENABLED, true),
            startMin = prefs.getInt(START, 22 * 60),
            endMin = prefs.getInt(END, 7 * 60),
            brightness = prefs.getFloat(BRIGHT, 0.55f)
        )
    }

    fun save(context: Context, schedule: NightSchedule) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putBoolean(ENABLED, schedule.enabled)
            .putInt(START, schedule.startMin)
            .putInt(END, schedule.endMin)
            .putFloat(BRIGHT, schedule.brightness)
            .apply()
    }

    fun active(context: Context, now: Calendar = Calendar.getInstance()): Boolean {
        val schedule = load(context)
        return isNight(schedule, now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE))
    }

    /** Forces the dark palette and dims the window. Restores both when the window ends. */
    fun apply(activity: Activity, now: Calendar = Calendar.getInstance()) {
        val schedule = load(activity)
        val on = isNight(schedule, now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE))
        ThemeState.nightForced = on
        val params = activity.window.attributes
        params.screenBrightness = if (on) schedule.brightness.coerceIn(0.15f, 1f) else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        activity.window.attributes = params
    }
}
