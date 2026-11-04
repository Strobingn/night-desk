package com.dirk.nightdesk.pump

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.journal.JournalScreen
import com.dirk.nightdesk.journal.ReplayScreen
import com.dirk.nightdesk.portfolio.PortfolioScreen
import com.dirk.nightdesk.ui.P

data class PumpFeature(
    val id: String,
    val label: String,
    val screen: (@Composable () -> Unit)? = null
)

/**
 * Pump tab registry. Later chunks append a line here.
 * NightDeskApp mounts a single Pump tab that reads this list.
 */
val PUMP_FEATURES = listOf(
    PumpFeature("core", "Curve"),
    PumpFeature("journal", "Journal", { JournalScreen() }),
    PumpFeature("replay", "Replay", { ReplayScreen() }),
    PumpFeature("portfolio", "Portfolio", { PortfolioScreen() })
)

@Composable
fun PumpScreen() {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Pump", color = P.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(
            "Simulate-only until this session is armed. The wallet signs. A restart disarms.",
            color = P.muted,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 6.dp, bottom = 12.dp)
        )
        PUMP_FEATURES.forEach { feature ->
            Text(feature.label, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp))
            Text(feature.id, color = P.dim, fontSize = 12.sp)
            feature.screen?.invoke()
        }
    }
}
