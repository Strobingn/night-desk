package com.dirk.nightdesk.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.DeskSnapshot
import com.dirk.nightdesk.OneTap
import java.util.Locale

/**
 * v13.5 read-only live wallet card: public address, SOL / USDC, key loaded yes/no, LIVE on/off,
 * and the live size / cap / trail. The private key never reaches the phone.
 */
@Composable
fun WalletCard(snap: DeskSnapshot?, modifier: Modifier = Modifier) {
    val w = snap?.wallet
    val live = w?.live == true || snap?.mode == "live"
    val clipboard = LocalClipboardManager.current
    Column(
        modifier
            .deskCard()
            .then(if (live) Modifier.border(2.dp, P.down, RoundedCornerShape(20.dp)) else Modifier)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Live wallet", color = P.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Chip(
                if (live) "LIVE ON" else "LIVE OFF",
                if (live) P.onDown else if (w?.keyLoaded == true) P.amber else P.muted,
                if (live) P.down else if (w?.keyLoaded == true) P.amber.copy(alpha = 0.16f) else P.card3,
                size = 11
            )
        }
        Row(Modifier.fillMaxWidth()) {
            WalletStat("Address", OneTap.shortAddress(w?.publicKey), Modifier.weight(1f), mono = true)
            WalletStat("Key loaded", if (w?.keyLoaded == true) "Yes" else "No", Modifier.weight(1f), color = if (w?.keyLoaded == true) P.up else P.down)
        }
        Row(Modifier.fillMaxWidth()) {
            WalletStat("SOL", OneTap.formatSolHolding(w?.solBalance, w?.solPriceUsd), Modifier.weight(1f))
            WalletStat("USDC", w?.usdcBalance?.let { OneTap.formatBalanceUsd(it) } ?: "—", Modifier.weight(1f))
        }
        val trail = (snap?.liveTrailPct ?: 0.01) * 100
        Text(
            "Live: ${money(snap?.liveTradeUsd ?: 5.0)} per trade · " +
                (snap?.liveDailyCapUsd?.let { "daily cap ${money(it)}" } ?: "no daily cap") +
                " · trail ${"%.1f".format(Locale.US, trail)}% · hard stop −${"%.0f".format(Locale.US, (snap?.stopLossPct ?: 0.06) * 100)}%" +
                (w?.liveSpentTodayUsd?.takeIf { it > 0 }?.let { " · ${money(it)} spent today" } ?: ""),
            color = P.ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold
        )
        OneTap.walletLines(w, snap?.mode ?: "paper").forEach { line ->
            Text("• $line", color = P.ink, fontSize = 12.5.sp, lineHeight = 17.sp)
        }
        if (!w?.publicKey.isNullOrBlank()) {
            TextButton(onClick = { clipboard.setText(AnnotatedString(w?.publicKey ?: "")) }) { Text("Copy address", color = P.accent) }
        }
        Text(
            "Read-only. A Jupiter buy spends USDC and keeps about ${w?.minFeeSol ?: 0.005} SOL for fees. A pump curve buy spends SOL. The private key stays on the desk host and is never sent to this phone." +
                (w?.balanceError?.let { " Balance is not current: $it" } ?: ""),
            color = P.dim,
            fontSize = 11.5.sp,
            lineHeight = 15.sp
        )
    }
}

@Composable
private fun WalletStat(label: String, value: String, modifier: Modifier, mono: Boolean = false, color: androidx.compose.ui.graphics.Color = P.ink) {
    Column(modifier) {
        Text(label.uppercase(), color = P.muted, fontSize = 10.5.sp, letterSpacing = 0.8.sp)
        Text(value, color = color, fontSize = 15.sp, fontWeight = FontWeight.Bold, fontFamily = if (mono) FontFamily.Monospace else null, maxLines = 1)
    }
}

private fun money(n: Double): String = "$" + "%,.2f".format(Locale.US, n)
