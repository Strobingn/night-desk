package com.dirk.nightdesk.journal

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

/** PNG desk report plus the system share sheet. The file lives on the cache path declared for FileProvider. */
object ReportImage {
    const val CACHE_DIR = "desk-reports"
    const val AUTHORITY_SUFFIX = ".deskreport"

    fun authority(packageName: String): String = packageName + AUTHORITY_SUFFIX

    fun shareIntent(uri: Uri): Intent {
        return Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, "Night Desk report")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    fun render(context: Context, lines: List<String>): File {
        val width = 880
        val height = (48 + lines.size * 36).coerceAtLeast(360)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(10, 14, 18))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(34, 211, 238)
            style = Paint.Style.FILL
        }
        canvas.drawRect(0f, 0f, width.toFloat(), 8f, paint)
        paint.color = Color.rgb(247, 247, 247)
        paint.textSize = 28f
        lines.forEachIndexed { index, line ->
            canvas.drawText(line, 32f, 56f + index * 36f, paint)
        }
        val dir = File(context.cacheDir, CACHE_DIR)
        dir.mkdirs()
        val file = File(dir, "desk-report.png")
        FileOutputStream(file).use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
        bitmap.recycle()
        return file
    }

    fun shareText(context: Context, name: String, text: String, mime: String) {
        val dir = File(context.cacheDir, CACHE_DIR)
        dir.mkdirs()
        val file = File(dir, name)
        file.writeText(text)
        val uri = FileProvider.getUriForFile(context, authority(context.packageName), file)
        val send = Intent.createChooser(
            Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
            "Export journal"
        )
        send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(send)
    }

    fun share(context: Context, lines: List<String>) {
        val file = render(context, lines)
        val uri = FileProvider.getUriForFile(context, authority(context.packageName), file)
        val send = Intent.createChooser(shareIntent(uri), "Share desk report")
        send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(send)
    }
}
