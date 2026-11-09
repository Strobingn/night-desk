package com.dirk.nightdesk

import android.content.Context
import android.util.Log
import java.io.File

/** The last uncaught stack, kept on disk so the next launch can show it. */
object CrashLog {
    private const val FILE = "last-crash.txt"
    private const val UPLOADED = "last-crash.uploaded"
    private const val HIDDEN = "last-crash.hidden"

    fun write(context: Context, thread: Thread, error: Throwable) {
        val app = context.applicationContext
        val text = buildString {
            append("version ").append(BuildConfig.VERSION_NAME).append('\n')
            append("thread ").append(thread.name).append('\n')
            append(Log.getStackTraceString(error))
        }
        runCatching {
            app.openFileOutput(FILE, Context.MODE_PRIVATE).use { it.write(text.toByteArray()) }
            app.deleteFile(UPLOADED)
            app.deleteFile(HIDDEN)
        }
    }

    fun read(context: Context): String? {
        val file = File(context.applicationContext.filesDir, FILE)
        if (!file.exists() || file.length() == 0L) return null
        return runCatching { file.readText() }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    /** Home dismiss. The crash file stays so Settings can still show it. */
    fun hide(context: Context) {
        runCatching {
            context.applicationContext.openFileOutput(HIDDEN, Context.MODE_PRIVATE).use { it.write(byteArrayOf(1)) }
        }
    }

    fun isHidden(context: Context): Boolean = File(context.applicationContext.filesDir, HIDDEN).exists()

    fun clear(context: Context) {
        val app = context.applicationContext
        app.deleteFile(FILE)
        app.deleteFile(UPLOADED)
    }

    fun needsUpload(context: Context): Boolean {
        val app = context.applicationContext
        return File(app.filesDir, FILE).exists() && !File(app.filesDir, UPLOADED).exists()
    }

    fun markUploaded(context: Context) {
        runCatching {
            context.applicationContext.openFileOutput(UPLOADED, Context.MODE_PRIVATE).use { it.write(byteArrayOf()) }
        }
    }
}
