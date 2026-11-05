package com.dirk.nightdesk.pump.alerts

import android.app.Activity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ui.P

@Composable
fun AlertRulesScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? Activity
    var schedule by remember { mutableStateOf(NightMode.load(context)) }
    val fcm = remember { FirebaseGate.ready(context) }
    val fullScreen = remember { FullScreenGate.canUse(context) }
    var note by remember { mutableStateOf(if (fcm) "FCM is configured." else "Local rules only. Firebase is not configured, so a swiped-away app will not get a push until google-services.json is added.") }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(4.dp)) {
        Text("Desk alerts", color = P.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(note, color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp, bottom = 8.dp))
        Text(
            if (NightMode.isNight(schedule, java.util.Calendar.getInstance().let { it.get(java.util.Calendar.HOUR_OF_DAY) * 60 + it.get(java.util.Calendar.MINUTE) }))
                "Night mode is on. Dark theme, brightness ${schedule.brightness}."
            else
                "Night mode is off.",
            color = P.dim,
            fontSize = 13.sp
        )
        Text("Window ${schedule.startMin / 60}:${(schedule.startMin % 60).toString().padStart(2, '0')} – ${schedule.endMin / 60}:${(schedule.endMin % 60).toString().padStart(2, '0')}", color = P.muted, fontSize = 12.sp)
        Button(onClick = {
            schedule = schedule.copy(enabled = !schedule.enabled)
            NightMode.save(context, schedule)
            activity?.let { NightMode.apply(it) }
        }, modifier = Modifier.padding(top = 8.dp)) {
            Text(if (schedule.enabled) "Disable night schedule" else "Enable night schedule")
        }
        if (!fullScreen) {
            Text("Full-screen alerts need the Android 14 grant. Until then they use a heads-up.", color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            Button(onClick = { context.startActivity(FullScreenGate.manageIntent(context)) }, modifier = Modifier.padding(top = 6.dp)) {
                Text("Allow full-screen intents")
            }
        }
        Button(onClick = {
            val engine = LocalAlertEngine(listOf(LocalRule("curve-50", "curve", 50.0, 5.0, 0, "sound")))
            val first = engine.evaluate(LocalSample("mint", 1, progressPct = 60.0))
            val second = engine.evaluate(LocalSample("mint", 2, progressPct = 70.0))
            note = "Local curve rule fired ${first.size} then ${second.size} (second stay above the band is silent)."
            if (first.isNotEmpty()) AlertNotifier.show(context, "Night Desk", first.first().message, first.first().delivery)
        }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) {
            Text("Test local rule")
        }
        Button(onClick = onBack, modifier = Modifier.padding(top = 8.dp)) { Text("Back") }
    }
}
