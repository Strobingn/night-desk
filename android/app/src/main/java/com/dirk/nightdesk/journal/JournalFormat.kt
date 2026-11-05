package com.dirk.nightdesk.journal

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * CSV timestamps for the desk journal. America/New_York with the numeric offset,
 * so July is -04:00 and January is -05:00.
 */
object JournalFormat {
    private val zone = ZoneId.of("America/New_York")
    private val wall = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS")

    const val HEADER =
        "timestamp_et,signature,wallet,mint,symbol,side,venue,size_lamports,token_amount,price_lamports_per_token,market_cap_lamports,fee_lamports,realized_pnl_lamports,outcome,cost_basis_reason"

    fun formatEt(epochMs: Long): String {
        val zoned = Instant.ofEpochMilli(epochMs).atZone(zone)
        return wall.format(zoned) + zoned.offset.id
    }

    fun csv(rows: List<JournalFill>): String {
        val lines = mutableListOf(HEADER)
        for (row in rows) {
            lines += listOf(
                formatEt(row.timestamp),
                row.signature,
                row.wallet,
                row.mint,
                row.symbol,
                row.side,
                row.venue,
                row.solLamports,
                row.tokenAmount,
                row.priceLamportsPerToken,
                row.marketCapLamports,
                row.feeLamports,
                row.realizedPnlLamports ?: "",
                row.outcome,
                row.costBasisReason
            ).joinToString(",") { cell(it) }
        }
        return lines.joinToString("\n") + "\n"
    }

    private fun cell(value: String): String {
        if (value.contains('"') || value.contains(',') || value.contains('\n')) {
            return "\"" + value.replace("\"", "\"\"") + "\""
        }
        return value
    }
}

data class JournalFill(
    val signature: String,
    val wallet: String,
    val mint: String,
    val symbol: String = "",
    val side: String,
    val venue: String,
    val solLamports: String,
    val tokenAmount: String,
    val feeLamports: String,
    val marketCapLamports: String,
    val priceLamportsPerToken: String,
    val timestamp: Long,
    val outcome: String = "",
    val realizedPnlLamports: String? = null,
    val costBasisReason: String = ""
)
