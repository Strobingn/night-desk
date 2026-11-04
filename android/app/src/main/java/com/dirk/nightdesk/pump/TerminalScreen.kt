package com.dirk.nightdesk.pump

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.DeskRepository
import com.dirk.nightdesk.ui.P
import com.dirk.nightdesk.wallet.MwaHost
import com.dirk.nightdesk.wallet.MwaSigner
import com.dirk.nightdesk.wallet.SecureStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.math.BigInteger

private const val STALE_MS = 5_000L

private fun applyFrame(
    text: String,
    points: SnapshotStateList<BigInteger>,
    tape: SnapshotStateList<TapePrint>,
    setCurve: (CurveView) -> Unit,
    setTick: (Long) -> Unit
) {
    val json = runCatching { JSONObject(text) }.getOrNull() ?: return
    if (json.optString("type") != "pump") return
    val data = json.optJSONObject("data") ?: return
    if (data.has("marketCapLamports") && !data.has("isBuy")) {
        val next = runCatching { PumpApi.parseCurve(data) }.getOrNull() ?: return
        setCurve(next)
        points.add(next.marketCapLamports)
        while (points.size > 240) points.removeAt(0)
        setTick(System.currentTimeMillis())
    } else if (data.has("isBuy")) {
        tape.add(0, TapePrint(
            data.optString("signature").ifBlank { data.optLong("timestamp").toString() },
            data.optBoolean("isBuy"),
            data.optString("solAmountLamports", "0"),
            data.optString("user")
        ))
        while (tape.size > 40) tape.removeAt(tape.lastIndex)
        setTick(System.currentTimeMillis())
    }
}

/**
 * Live curve: market cap, graduation progress, SOL in the curve, the trade tape,
 * and a buy that pre-fills SOL for a target market cap. Simulate mode does not open a wallet.
 */
@Composable
fun TerminalScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var mint by remember { mutableStateOf("") }
    var active by remember { mutableStateOf("") }
    var curve by remember { mutableStateOf<CurveView?>(null) }
    val tape = remember { mutableStateListOf<TapePrint>() }
    val points = remember { mutableStateListOf<BigInteger>() }
    var lastTick by remember { mutableLongStateOf(0L) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var targetSol by remember { mutableStateOf("") }
    var solField by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("Simulate-only until this process is armed. The wallet signs. Night Desk does not broadcast or retry.") }
    var live by remember { mutableStateOf(false) }
    var armed by remember { mutableStateOf(false) }
    var cap by remember { mutableStateOf("5000000") }
    var wallet by remember { mutableStateOf(SecureStore.open(context).walletPubkey().orEmpty()) }
    var tick by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }

    LaunchedEffect(active) {
        curve = null
        points.clear()
        tape.clear()
        lastTick = 0L
    }

    LaunchedEffect(active, tick) {
        if (active.isBlank()) return@LaunchedEffect
        val repo = DeskRepository.get(context)
        val link = repo.currentLink()
        val base = repo.activeUrl.value.ifBlank { link.baseUrl }
        if (base.isBlank()) {
            note = "Set the desk URL before watching a curve."
            return@LaunchedEffect
        }
        val api = PumpApi()
        api.status(base, link.token)?.let {
            armed = it.armed
            cap = it.tradeCapLamports
        }
        api.watch(base, link.token, active)
        api.fetchCurve(base, link.token, active)?.let {
            curve = it
            points.add(it.marketCapLamports)
            while (points.size > 240) points.removeAt(0)
            lastTick = System.currentTimeMillis()
        }
        val prints = api.trades(base, link.token, active)
        if (prints.isNotEmpty()) {
            tape.clear()
            tape.addAll(prints.asReversed().take(40))
            lastTick = System.currentTimeMillis()
        }
    }

    DisposableEffect(active) {
        if (active.isBlank()) return@DisposableEffect onDispose { }
        val repo = DeskRepository.get(context)
        val main = Handler(Looper.getMainLooper())
        val holder = arrayOfNulls<okhttp3.WebSocket>(1)
        val alive = java.util.concurrent.atomic.AtomicBoolean(true)
        scope.launch {
            val link = repo.currentLink()
            val base = repo.activeUrl.value.ifBlank { link.baseUrl }
            if (base.isBlank() || !alive.get()) return@launch
            val socket = PumpApi().openCurveSocket(base, link.token, active) { text ->
                if (!alive.get()) return@openCurveSocket
                main.post {
                    if (!alive.get()) return@post
                    applyFrame(text, points, tape, { curve = it }, { lastTick = it })
                }
            }
            if (!alive.get()) socket.close(1000, null) else holder[0] = socket
        }
        onDispose {
            alive.set(false)
            holder[0]?.close(1000, null)
        }
    }

    val stale = lastTick > 0 && now - lastTick >= STALE_MS
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text("Bonding curve", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(if (stale) "Stale" else if (lastTick > 0) "Live" else "Waiting", color = if (stale) P.amber else P.muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        OutlinedTextField(mint, { mint = it }, label = { Text("Mint") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Button(onClick = { active = mint.trim(); tick += 1 }) { Text("Watch") }
        val shown = curve
        Text("Mcap ${shown?.let { CurveMath.formatSol(it.marketCapLamports) } ?: "—"} SOL", color = P.ink)
        Text("Progress ${shown?.progressPct?.let { "%.2f".format(it) } ?: "—"}%", color = P.ink)
        Text("SOL in curve ${shown?.let { CurveMath.formatSol(it.solInCurveLamports) } ?: "—"}", color = P.ink)
        Text("SOL to graduate ${shown?.let { CurveMath.formatSol(it.solRemainingLamports) } ?: "—"}", color = P.ink)
        Text("Graduation mcap ${shown?.let { CurveMath.formatSol(it.graduationMarketCapLamports) } ?: "—"} SOL", color = P.ink)
        Text(if (wallet.isBlank()) "Wallet not connected" else "Wallet ${wallet.take(4)}…${wallet.takeLast(4)}", color = P.dim, fontSize = 12.sp)
        Canvas(Modifier.fillMaxWidth().height(120.dp)) {
            if (points.size < 2) return@Canvas
            val vals = points.map { it.toDouble() }
            val min = vals.min()
            val max = vals.max()
            val span = (max - min).takeIf { it > 0 } ?: 1.0
            val step = size.width / (points.size - 1)
            for (i in 1 until points.size) {
                val y1 = size.height - ((vals[i - 1] - min) / span).toFloat() * (size.height - 8f) - 4f
                val y2 = size.height - ((vals[i] - min) / span).toFloat() * (size.height - 8f) - 4f
                drawLine(P.accent, Offset(step * (i - 1), y1), Offset(step * i, y2), strokeWidth = 4f)
            }
        }
        tape.take(8).forEach { row ->
            Text("${if (row.isBuy) "Buy" else "Sell"} ${formatTape(row.solLamports)} SOL", color = if (row.isBuy) P.up else P.down, fontSize = 13.sp)
        }
        OutlinedTextField(targetSol, { targetSol = it }, label = { Text("Target mcap (SOL)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(solField, { solField = it }, label = { Text("SOL into curve") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(live, { live = it })
            Text(if (armed) "Live (session armed)" else "Live (session is simulate-only)", color = P.dim, fontSize = 13.sp)
        }
        Button(onClick = {
            scope.launch { note = buy(context, shown, targetSol, live, armed, wallet, cap) { solField = it } }
        }, enabled = shown != null) { Text("Buy into curve") }
        Button(onClick = {
            scope.launch {
                val session = MwaHost.session
                if (session == null) {
                    note = "Wallet bridge is not attached."
                    return@launch
                }
                runCatching { session.connect() }.onSuccess {
                    wallet = it
                    SecureStore.open(context).saveWalletPubkey(it)
                    note = "Connected ${it.take(4)}…${it.takeLast(4)}"
                }.onFailure { note = it.message ?: "Connect failed." }
            }
        }) { Text("Connect Phantom or Solflare") }
        Button(onClick = {
            val target = solToLamports(targetSol)
            val shownCurve = curve
            if (target == null || shownCurve == null) {
                note = "Watch a mint and enter a target market cap first."
                return@Button
            }
            scope.launch {
                val repo = DeskRepository.get(context)
                val link = repo.currentLink()
                val base = repo.activeUrl.value.ifBlank { link.baseUrl }
                if (base.isBlank()) {
                    note = "Set the desk URL before arming an alert."
                    return@launch
                }
                PumpPriceAlertWorker.enqueue(context, shownCurve.mint, target.toString(), base, link.token)
                note = "Price alert armed for ${CurveMath.formatSol(target)} SOL mcap."
            }
        }) { Text("Alert at target mcap") }
        Text(note, color = P.muted, fontSize = 12.sp)
    }
}

private suspend fun buy(
    context: Context,
    curve: CurveView?,
    targetSol: String,
    live: Boolean,
    armed: Boolean,
    wallet: String,
    cap: String,
    onPrefill: (String) -> Unit
): String {
    if (curve == null) return "No curve yet."
    val target = solToLamports(targetSol) ?: return "Target market cap is a SOL amount with at most 9 decimals."
    val reverse = CurveMath.solToReachMarketCap(curve.reserves(), target)
    onPrefill(CurveMath.formatSol(reverse.solNeededLamports))
    if (reverse.solNeededLamports.signum() <= 0) return "The curve is already at that market cap."
    if (wallet.isBlank()) return "Pre-filled ${CurveMath.formatSol(reverse.solNeededLamports)} SOL. Connect Phantom or Solflare to prepare the transaction."
    val repo = DeskRepository.get(context)
    val link = repo.currentLink()
    val base = repo.activeUrl.value.ifBlank { link.baseUrl }
    if (base.isBlank()) return "Set the desk URL before preparing a buy."
    val prepared = PumpApi().prepare(base, link.token, wallet, curve.mint, reverse.solNeededLamports.toString(), live && armed)
        ?: return "Prepare failed."
    val session = MwaHost.session
    val signer = session?.let { MwaSigner(it) }
    if (signer == null || prepared.simulateOnly || !live) {
        return "Simulate mode. The wallet stays closed. Pre-filled ${CurveMath.formatSol(reverse.solNeededLamports)} SOL."
    }
    val approved = signer.approve(
        prepared.unsignedTx,
        wallet,
        prepared.solLamports.toBigIntegerOrNull() ?: reverse.solNeededLamports,
        cap.toBigIntegerOrNull() ?: BigInteger("5000000"),
        simulateOnly = false
    )
    return approved.message
}

internal fun solToLamports(text: String): BigInteger? {
    val trimmed = text.trim()
    if (!trimmed.matches(Regex("^\\d+(\\.\\d{1,9})?$"))) return null
    val parts = trimmed.split('.')
    val frac = parts.getOrElse(1) { "" }.padEnd(9, '0')
    return parts[0].toBigInteger().multiply(CurveMath.LAMPORTS).add(frac.toBigInteger())
}

private fun formatTape(lamports: String): String = lamports.toBigIntegerOrNull()?.let { CurveMath.formatSol(it) } ?: lamports
