package com.dirk.nightdesk.wallet

import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import java.math.BigInteger

/**
 * Opens Phantom or Solflare through the Mobile Wallet Adapter.
 * Simulate mode returns before the session is touched. A live approve signs once
 * and does not broadcast or retry.
 */
interface WalletSession {
    val pubkey: String?
    suspend fun connect(): String
    suspend fun sign(unsigned: ByteArray): ByteArray
}

data class ApproveResult(
    val opened: Boolean,
    val code: String,
    val message: String,
    val signed: ByteArray? = null
)

class MwaSigner(
    private val session: WalletSession,
    private val guard: TxGuard = TxGuard()
) {
    suspend fun approve(
        unsignedTx: String?,
        wallet: String,
        amountLamports: BigInteger,
        capLamports: BigInteger,
        simulateOnly: Boolean
    ): ApproveResult {
        if (simulateOnly) {
            return ApproveResult(false, "SIMULATED", "Simulate mode. The wallet stays closed.")
        }
        if (unsignedTx.isNullOrBlank()) {
            return ApproveResult(false, "NO_TX", "No unsigned transaction to sign.")
        }
        val verdict = guard.inspect(unsignedTx, wallet, amountLamports, capLamports)
        if (!verdict.ok) {
            return ApproveResult(false, "GUARD", verdict.message ?: "Transaction rejected.")
        }
        if (session.pubkey != wallet) {
            return ApproveResult(false, "NO_WALLET", "Connect the fee-payer wallet first.")
        }
        val signed = session.sign(TxGuard.bytesFromBase64(unsignedTx))
        return ApproveResult(true, "SIGNED", "Signed once in the wallet. Night Desk does not broadcast or retry.", signed)
    }
}

/** Holds the activity result sender created in [MainActivity.onCreate], before the activity starts. */
object MwaHost {
    @Volatile
    var session: WalletSession? = null
        private set

    fun attach(activity: ComponentActivity) {
        if (session == null) session = AndroidMwaSession(ActivityResultSender(activity))
    }
}

class AndroidMwaSession(private val sender: ActivityResultSender) : WalletSession {
    private val adapter = MobileWalletAdapter(
        ConnectionIdentity(
            Uri.parse("https://nightdesk.app"),
            Uri.parse("favicon.ico"),
            "Night Desk"
        )
    ).apply { blockchain = Solana.Mainnet }

    override var pubkey: String? = null
        private set

    override suspend fun connect(): String {
        when (val result = adapter.connect(sender)) {
            is TransactionResult.Success -> {
                val raw = result.authResult.accounts.firstOrNull()?.publicKey ?: error("Wallet returned no account.")
                val address = TxGuard.encodeBase58(raw)
                pubkey = address
                return address
            }
            is TransactionResult.NoWalletFound -> error("No Phantom or Solflare wallet is installed.")
            is TransactionResult.Failure -> error(result.message)
        }
    }

    override suspend fun sign(unsigned: ByteArray): ByteArray {
        val result = adapter.transact(sender) {
            signTransactions(arrayOf(unsigned))
        }
        return when (result) {
            is TransactionResult.Success -> result.payload.signedPayloads.firstOrNull()
                ?: error("Wallet returned no signed transaction.")
            is TransactionResult.NoWalletFound -> error("No Phantom or Solflare wallet is installed.")
            is TransactionResult.Failure -> error(result.message)
        }
    }
}
