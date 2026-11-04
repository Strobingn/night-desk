package com.dirk.nightdesk.pump.scanner

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.ui.P
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun ScannerScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val desk = remember { DeskRepository.get(context) }
    val scope = rememberCoroutineScope()
    var body by remember { mutableStateOf("Loading the top 20…") }
    var wallet by remember { mutableStateOf("") }
    var buy by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        while (true) {
            val result = desk.pumpGet("/api/pump/scanner")
            body = result.fold(
                onSuccess = { text -> formatBoard(text) },
                onFailure = { "Scanner is waiting for the desk (${it.message})." }
            )
            delay(5_000)
        }
    }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(4.dp)) {
        Text("Hot scanner", color = P.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("Refreshes every 5 seconds. Rug-flagged coins score 0.", color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
        Text(body, color = P.dim, fontSize = 13.sp)
        OutlinedTextField(wallet, { wallet = it }, label = { Text("Wallet") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
        Button(onClick = {
            scope.launch {
                val payload = JSONObject()
                    .put("enabled", true)
                    .put("wallet", wallet)
                    .put("solLamports", "5000000")
                    .put("live", false)
                    .toString()
                val result = desk.pumpPost("/api/pump/scanner/auto-buy", payload)
                buy = result.fold(
                    onSuccess = { text ->
                        val json = JSONObject(text)
                        val intent = json.optJSONObject("intent")
                        val simulate = intent?.optBoolean("simulateOnly", true) ?: json.optBoolean("simulateOnly", true)
                        if (simulate) "Simulate-only (${json.optString("reason")}). Nothing was sent."
                        else "Armed. Unsigned transaction is ready for the wallet."
                    },
                    onFailure = { it.message ?: "Could not prepare." }
                )
            }
        }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text("Prepare best (simulate unless armed)")
        }
        if (buy.isNotEmpty()) Text(buy, color = P.ink, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
        Text("The wallet approves the unsigned transaction. This screen never signs.", color = P.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        Button(onClick = onBack, modifier = Modifier.padding(top = 8.dp)) { Text("Back") }
    }
}

internal fun formatBoard(json: String): String {
    val root = JSONObject(json)
    val coins = root.optJSONArray("coins") ?: return "No coins."
    if (coins.length() == 0) return "No new coins in the book yet."
    return buildString {
        val n = minOf(20, coins.length())
        for (i in 0 until n) {
            val row = coins.getJSONObject(i)
            val score = row.optDouble("score", 0.0)
            val rug = row.optJSONArray("rug")
            val flag = if (rug != null && rug.length() > 0) " rug" else ""
            append(row.optString("symbol").ifBlank { row.optString("mint").take(4) })
            append("  ")
            append("%.3f".format(score))
            append(flag)
            append('\n')
        }
    }
}
