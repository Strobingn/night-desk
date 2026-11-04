package com.dirk.nightdesk.sniper

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
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
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * One tap hands the already-built unsigned transaction to the wallet.
 * Declining or a wallet failure does not ask the server for a new transaction.
 * A successful sign acks the same intent as filled.
 */
class SniperApproveActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val sender by lazy { ActivityResultSender(this) }
    private var status by mutableStateOf("Review the graduation buy, then approve it in your wallet.")
    private var busy by mutableStateOf(false)
    private var signed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mint = intent.getStringExtra(EXTRA_MINT).orEmpty()
        val tx = intent.getStringExtra(EXTRA_TX).orEmpty()
        setContent {
            NightTheme {
                Column(Modifier.fillMaxSize().padding(20.dp)) {
                    Text("Approve graduation buy", color = P.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text(mint, color = P.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                    Text(status, color = P.ink, fontSize = 15.sp, modifier = Modifier.padding(top = 12.dp, bottom = 16.dp))
                    Button(onClick = { approve(mint, tx) }, enabled = !busy && !signed && tx.isNotBlank()) {
                        Text("Approve in wallet")
                    }
                }
            }
        }
    }

    private fun approve(mint: String, tx: String) {
        if (busy || signed) return
        busy = true
        status = "Opening the wallet…"
        val bytes = runCatching { Base64.decode(tx, Base64.DEFAULT) }.getOrNull()
        if (bytes == null) {
            busy = false
            status = "The prepared transaction could not be read."
            return
        }
        scope.launch {
            val ok = signOnce(sender, bytes)
            if (!ok) {
                busy = false
                status = "The wallet did not sign. The same transaction is still waiting — nothing was resubmitted."
                return@launch
            }
            signed = true
            val acked = ack(intent.getStringExtra(EXTRA_URL).orEmpty(), intent.getStringExtra(EXTRA_TOKEN).orEmpty(), mint)
            status = if (acked) "Signed. The desk will not build another buy for this graduation." else "Signed. The desk ack did not land; do not arm it again."
            busy = false
        }
    }

    companion object {
        const val EXTRA_MINT = "sniper_mint"
        const val EXTRA_TX = "sniper_tx"
        const val EXTRA_URL = "sniper_url"
        const val EXTRA_TOKEN = "sniper_token"

        fun intent(context: Context, mint: String, unsignedTx: String, baseUrl: String, token: String): Intent {
            return Intent(context, SniperApproveActivity::class.java).apply {
                putExtra(EXTRA_MINT, mint)
                putExtra(EXTRA_TX, unsignedTx)
                putExtra(EXTRA_URL, baseUrl)
                putExtra(EXTRA_TOKEN, token)
            }
        }
    }
}

/** One Mobile Wallet Adapter session over the bytes the server already built. */
suspend fun signOnce(sender: ActivityResultSender, unsignedTx: ByteArray): Boolean {
    val adapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://night-desk.local"),
            iconUri = Uri.parse("https://night-desk.local/icon.png"),
            identityName = "Night Desk"
        )
    )
    val result = adapter.transact(sender) {
        signTransactions(arrayOf(unsignedTx))
    }
    return result is TransactionResult.Success
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
        conn.outputStream.use { it.write(JSONObject().put("mint", mint).put("result", "filled").toString().toByteArray()) }
        conn.responseCode in 200..299
    } catch (_: Exception) {
        false
    } finally {
        conn.disconnect()
    }
}

/** Test hook: the activity's approve button posts this result and never a second mint. */
fun approvalPayload(mint: String): String = JSONObject().put("mint", mint).put("result", "filled").toString()
