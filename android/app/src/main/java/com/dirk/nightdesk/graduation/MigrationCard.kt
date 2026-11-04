package com.dirk.nightdesk.graduation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ui.P

/** LP figures for a graduated coin. Null is the empty state before a pool is known. */
data class MigrationView(
    val venue: String,
    val poolClass: String,
    val lpSupply: String,
    val lpBurnedPct: Double,
    val locked: Boolean,
    val stillLocked: Boolean?,
    val owners: List<String>
)

fun migrationLines(view: MigrationView?): List<String> {
    if (view == null) {
        return listOf("After graduation the coin view follows its PumpSwap or Raydium pool.")
    }
    val lock = when (view.stillLocked) {
        null -> if (view.locked) "locked" else "unlocked"
        true -> "still locked"
        false -> "lock dropped"
    }
    val burned = if (view.lpBurnedPct % 1.0 == 0.0) view.lpBurnedPct.toInt().toString() else view.lpBurnedPct.toString()
    val lines = mutableListOf(
        "${view.venue} · ${view.poolClass}",
        "LP supply ${view.lpSupply}",
        "LP burned $burned%",
        lock
    )
    view.owners.forEach { lines += it }
    return lines
}

@Composable
fun MigrationCard(view: MigrationView?) {
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text("Migration", color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        migrationLines(view).forEach { line ->
            Text(line, color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        }
    }
}
