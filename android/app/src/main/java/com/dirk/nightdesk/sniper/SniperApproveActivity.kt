package com.dirk.nightdesk.sniper

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.ui.NightTheme
import com.dirk.nightdesk.ui.P
import com.dirk.nightdesk.wallet.AndroidMwaSession
import com.dirk.nightdesk.wallet.MwaHost
import com.dirk.nightdesk.wallet.MwaSigner
import com.dirk.nightdesk.wallet.WalletSession
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL

/**
 * One tap hands the already-built unsigned transaction to [MwaSigner].
 * TxGuard runs before the wallet opens. Declining, a guard reject, or a wallet
 * failure does not ack and does not ask the server for a new transaction.
 * A successful sign acks the same intent as filled. Nothing here broadcasts.
 */
class SniperApproveActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var ownSession: AndroidMwaSession
    private var status by mutableStateOf("Review the graduation buy, then approve it in your wallet.")
    private var busy by mutableStateOf(false)
    private var signed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ownSession = AndroidMwaSession(ActivityResultSender(this))
        val mint = intent.getStringExtra(EXTRA_MINT).orEmpty()
        val tx = intent.getStringExtra(EXTRA_TX).orEmpty()
        val wallet = intent.getStringExtra(EXTRA_WALLET).orEmpty()
        val amount = intent.getStringExtra(EXTRA_AMOUNT).orEmpty()
        val cap = intent.getStringExtra(EXTRA_CAP).orEmpty()
        val simulateOnly = intent.getBooleanExtra(EXTRA_SIMULATE, true)
        setContent {
            NightTheme {
                Column(Modifier.fillMaxSize().padding(20.dp)) {
                    Text("Approve graduation buy", color = P.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text(mint, color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                    Text(status, color = P.ink, fontSize = 15.sp, modifier = Modifier.padding(top = 12.dp, bottom = 16.dp))
                    Button(
                        onClick = { approve(mint, tx, wallet, amount, cap, simulateOnly) },
                        enabled = !busy && !signed && tx.isNotBlank() && wallet.isNotBlank()
                    ) {
                        Text("Approve in wallet")
                    }
                }
            }
        }
    }

    private fun approve(mint: String, tx: String, wallet: String, amount: String, cap: String, simulateOnly: Boolean) {
        if (busy || signed) return
        busy = true
        status = "Opening the wallet…"
        scope.launch {
            val approved = runCatching {
                val session = sessionFor(wallet)
                MwaSigner(session).approve(
                    tx,
                    wallet,
                    BigInteger(amount.ifBlank { "0" }),
                    BigInteger(cap.ifBlank { DEFAULT_CAP }),
                    simulateOnly
                )
            }.getOrElse { error ->
                busy = false
                status = error.message ?: "The wallet did not sign. The same transaction is still waiting — nothing was resubmitted."
                return@launch
            }
            if (approved.code != "SIGNED") {
                busy = false
                status = approved.message
                return@launch
            }
            signed = true
            val acked = withContext(Dispatchers.IO) {
                ack(intent.getStringExtra(EXTRA_URL).orEmpty(), intent.getStringExtra(EXTRA_TOKEN).orEmpty(), mint)
            }
            status = if (acked) "Signed. The desk will not build another buy for this graduation." else "Signed. The desk ack did not land; do not arm it again."
            busy = false
        }
    }

    /** Reuse the desk session when it is already the fee payer. Otherwise connect once on this screen. */
    private suspend fun sessionFor(wallet: String): WalletSession {
        val shared = MwaHost.session
        if (shared != null && shared.pubkey == wallet) return shared
        if (ownSession.pubkey != wallet) {
            val connected = ownSession.connect()
            if (connected != wallet) error("Connected wallet does not match the fee payer. Nothing was signed.")
        }
        return ownSession
    }

    companion object {
        const val EXTRA_MINT = "sniper_mint"
        const val EXTRA_TX = "sniper_tx"
        const val EXTRA_URL = "sniper_url"
        const val EXTRA_TOKEN = "sniper_token"
        const val EXTRA_WALLET = "sniper_wallet"
        const val EXTRA_AMOUNT = "sniper_amount"
        const val EXTRA_CAP = "sniper_cap"
        const val EXTRA_SIMULATE = "sniper_simulate"
        const val DEFAULT_CAP = "1000000000"

        fun intent(
            context: Context,
            mint: String,
            unsignedTx: String,
            baseUrl: String,
            token: String,
            wallet: String,
            amountLamports: String,
            capLamports: String,
            simulateOnly: Boolean
        ): Intent {
            return Intent(context, SniperApproveActivity::class.java).apply {
                putExtra(EXTRA_MINT, mint)
                putExtra(EXTRA_TX, unsignedTx)
                putExtra(EXTRA_URL, baseUrl)
                putExtra(EXTRA_TOKEN, token)
                putExtra(EXTRA_WALLET, wallet)
                putExtra(EXTRA_AMOUNT, amountLamports)
                putExtra(EXTRA_CAP, capLamports)
                putExtra(EXTRA_SIMULATE, simulateOnly)
            }
        }
    }
}

private fun ack(baseUrl: String, token: String, mint: String): Boolean {
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) return false
    val conn = (URL(baseUrl.trimEnd('/') + "/api/pump/sniper/ack").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 4_000
        readTimeout = 4_000
        doOutput = true
        setRequestProperty("content-type", "application/json")
        if (token.isNotBlank()) setRequestProperty("X-Desk-Token", token)
    }
    return try {
        conn.outputStream.use { it.write(approvalPayload(mint).toByteArray()) }
        conn.responseCode in 200..299
    } catch (_: Exception) {
        false
    } finally {
        conn.disconnect()
    }
}

/** Test hook: the activity's approve button posts this result and never a second mint. */
fun approvalPayload(mint: String): String {
    val safe = buildString(mint.length) {
        for (ch in mint) {
            when (ch) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                else -> append(ch)
            }
        }
    }
    return """{"mint":"$safe","result":"filled"}"""
}
