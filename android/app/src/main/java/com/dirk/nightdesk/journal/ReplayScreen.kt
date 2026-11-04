package com.dirk.nightdesk.journal

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ui.P

/** Scrub confirmed fills by market cap. */
@Composable
fun ReplayScreen() {
    val context = LocalContext.current
    var rows by remember { mutableStateOf(DeskCache.read(context)) }
    var index by remember { mutableIntStateOf(0) }
    LaunchedEffect(JournalRefresh.tick) {
        runCatching { PumpApi(context).journal() }.onSuccess {
            rows = it.sortedBy { row -> row.timestamp }
            DeskCache.write(context, rows)
            index = (rows.size - 1).coerceAtLeast(0)
        }
    }
    val frame = rows.getOrNull(index)
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text("Replay", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("Scrub through confirmed trades. The line is market cap at each fill.", color = P.muted, fontSize = 12.sp)
        Canvas(Modifier.fillMaxWidth().height(140.dp).padding(vertical = 8.dp)) {
            if (rows.size < 2) return@Canvas
            val caps = rows.map { it.marketCapLamports.toFloatOrNull() ?: 0f }
            val min = caps.minOrNull() ?: 0f
            val max = caps.maxOrNull() ?: 1f
            val span = (max - min).takeIf { it > 0f } ?: 1f
            val step = size.width / (rows.lastIndex.coerceAtLeast(1))
            for (i in 0 until rows.lastIndex) {
                val y0 = size.height - ((caps[i] - min) / span) * size.height
                val y1 = size.height - ((caps[i + 1] - min) / span) * size.height
                drawLine(P.accent, Offset(step * i, y0), Offset(step * (i + 1), y1), strokeWidth = 4f, cap = StrokeCap.Round)
            }
            val y = size.height - ((caps[index.coerceIn(0, rows.lastIndex)] - min) / span) * size.height
            drawCircle(P.ink, 8f, Offset(step * index, y))
        }
        if (rows.size > 1) {
            Slider(
                value = index.toFloat(),
                onValueChange = { index = it.toInt().coerceIn(0, rows.lastIndex) },
                valueRange = 0f..rows.lastIndex.toFloat()
            )
        }
        if (frame == null) {
            Text("No trades to replay.", color = P.muted, fontSize = 14.sp)
        } else {
            Text(
                "${frame.side} ${frame.symbol.ifBlank { frame.mint }} · mcap ${frame.marketCapLamports} · ${frame.solLamports} lamports",
                color = P.ink,
                fontSize = 13.sp
            )
        }
    }
}
