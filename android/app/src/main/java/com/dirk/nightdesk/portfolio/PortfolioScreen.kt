package com.dirk.nightdesk.portfolio

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.dirk.nightdesk.journal.DeskCache
import com.dirk.nightdesk.journal.PumpApi
import com.dirk.nightdesk.ui.P
import com.dirk.nightdesk.wallet.MwaHost
import com.dirk.nightdesk.wallet.SecureStore
import kotlinx.coroutines.launch

/** One or more read-only pubkeys and the pump positions behind them. */
@Composable
fun PortfolioScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember { SecureStore.open(context) }
    var wallets by remember { mutableStateOf(PortfolioWallets.read(store)) }
    var manual by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    val fills = DeskCache.read(context).map {
        PortfolioMath.Fill(it.signature, it.wallet, it.mint, it.side, it.solLamports, it.tokenAmount, it.feeLamports, it.timestamp)
    }
    val positions = PortfolioMath.positions(fills)
    val score = PortfolioMath.score(fills, System.currentTimeMillis())
    val realized = PortfolioMath.aggregateRealized(positions)

    Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Portfolio", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(
            "Addresses only. Connect uses the Mobile Wallet Adapter session and stores the pubkey in SecureStore. Signing stays on the terminal. Positions cover Night Desk fills and other pump.fun trades on the curve and PumpSwap.",
            color = P.muted,
            fontSize = 12.sp
        )
        TextButton(onClick = {
            val session = MwaHost.session
            if (session == null) {
                note = "Wallet authorize is not ready."
                return@TextButton
            }
            scope.launch {
                runCatching { session.connect() }
                    .onSuccess { address ->
                        store.saveWalletPubkey(address)
                        wallets = PortfolioWallets.add(store, address)
                        note = "Connected ${address.take(4)}…${address.takeLast(4)}"
                    }
                    .onFailure { note = it.message ?: "Authorize failed." }
            }
        }) { Text("Connect wallet", color = P.accent) }
        OutlinedTextField(value = manual, onValueChange = { manual = it }, label = { Text("Public key") }, modifier = Modifier.fillMaxWidth())
        TextButton(onClick = {
            runCatching { PortfolioWallets.add(store, manual) }
                .onSuccess {
                    wallets = it
                    manual = ""
                    note = ""
                }
                .onFailure { note = it.message ?: "That is not a public key." }
        }) { Text("Add address", color = P.accent) }
        Text(
            "Realized ${realized ?: "withheld until every cost basis is known"} · score ${score.score}",
            color = P.ink,
            fontSize = 13.sp
        )
        wallets.forEach { pubkey ->
            Text(pubkey, color = P.ink, fontSize = 12.sp)
            TextButton(onClick = {
                scope.launch {
                    runCatching { PumpApi(context).importChain(pubkey) }
                        .onSuccess { note = "Imported chain history for ${pubkey.take(4)}…" }
                        .onFailure { note = it.message ?: "Import failed." }
                }
            }) { Text("Import chain history", color = P.accent) }
        }
        positions.forEach { position ->
            val reason = position.realizedReason
            Text(
                "${position.mint.take(4)}… ${position.tokenAmount} tokens · " +
                    (position.avgEntryLamportsPerToken?.let { "avg $it" } ?: "") +
                    (if (position.realizedPnlLamports == null) reason ?: "cost basis unknown" else "pnl ${position.realizedPnlLamports}"),
                color = P.dim,
                fontSize = 12.sp
            )
        }
        if (note.isNotBlank()) Text(note, color = P.dim, fontSize = 12.sp)
        Text(PortfolioMath.FORMULA, color = P.muted, fontSize = 11.sp)
    }
}
