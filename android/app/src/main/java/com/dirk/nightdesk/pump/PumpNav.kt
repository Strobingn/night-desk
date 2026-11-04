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
import androidx.compose.foundation.clickable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.dirk.nightdesk.pump.alerts.AlertRulesScreen
import com.dirk.nightdesk.pump.scanner.ScannerScreen
import com.dirk.nightdesk.ui.P

data class PumpFeature(val id: String, val label: String)

/**
 * Pump tab registry. Later chunks append a line here.
 * NightDeskApp mounts a single Pump tab that reads this list.
 */
val PUMP_FEATURES = listOf(
    PumpFeature("core", "Curve"),
    PumpFeature("alerts", "Alerts"),
    PumpFeature("scanner", "Scanner")
)

@Composable
fun PumpScreen() {
    var open by remember { mutableStateOf<String?>(null) }
    if (open == "alerts") {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            AlertRulesScreen { open = null }
        }
        return
    }
    if (open == "scanner") {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            ScannerScreen { open = null }
        }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Pump", color = P.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(
            "Simulate-only until this session is armed. The wallet signs. A restart disarms.",
            color = P.muted,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 6.dp, bottom = 12.dp)
        )
        PUMP_FEATURES.forEach { feature ->
            Text(feature.label, color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp).clickable { open = feature.id })
            Text(feature.id, color = P.dim, fontSize = 12.sp)
        }
    }
}
