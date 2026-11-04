package com.dirk.nightdesk.journal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ui.P
import kotlinx.coroutines.launch

/** Confirmed buys and sells. A failed transaction is not shown. */
@Composable
fun JournalScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var rows by remember { mutableStateOf(DeskCache.read(context)) }
    var note by remember { mutableStateOf("") }

    LaunchedEffect(JournalRefresh.tick) {
        runCatching { PumpApi(context).journal() }
            .onSuccess {
                rows = it
                DeskCache.write(context, it)
                note = ""
            }
            .onFailure { note = it.message ?: "Showing the cached journal." }
    }

    Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Journal", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(
            "Buys and sells land here only after the chain confirms them. CSV times use the US Eastern offset.",
            color = P.muted,
            fontSize = 12.sp
        )
        Row {
            TextButton(onClick = {
                DeskCache.write(context, rows)
                ReportImage.shareText(context, "night-desk-journal.csv", JournalFormat.csv(rows), "text/csv")
            }) { Text("Export CSV", color = P.accent) }
            TextButton(onClick = {
                scope.launch {
                    ReportImage.share(context, reportLines(rows))
                }
            }) { Text("Share desk report", color = P.accent) }
        }
        if (note.isNotBlank()) Text(note, color = P.dim, fontSize = 12.sp)
        if (rows.isEmpty()) Text("No confirmed trades yet.", color = P.muted, fontSize = 14.sp)
        rows.forEach { row ->
            Text("${row.side} ${row.symbol.ifBlank { row.mint }}", color = P.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            val pnl = row.realizedPnlLamports?.let { "pnl $it lamports" } ?: row.costBasisReason
            Text(
                "${row.solLamports} lamports · mcap ${row.marketCapLamports} · fee ${row.feeLamports} · ${row.outcome} · $pnl",
                color = P.dim,
                fontSize = 12.sp
            )
        }
    }
}

private fun reportLines(rows: List<JournalFill>): List<String> {
    return listOf("NIGHT DESK", "DESK REPORT", "TRADES ${rows.size}") + rows.take(8).map { row ->
        val pnl = row.realizedPnlLamports ?: row.costBasisReason.ifBlank { row.outcome }
        "${row.side.uppercase()} ${row.symbol.ifBlank { row.mint.take(8) }} $pnl"
    }
}
