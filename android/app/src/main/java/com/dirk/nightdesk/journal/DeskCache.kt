package com.dirk.nightdesk.journal

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Local cache of confirmed journal rows. The server SQLite book is the source of truth. */
object DeskCache {
    private const val FILE = "nightdesk_pump_cache"
    private const val KEY = "journal"

    fun read(context: Context): List<JournalFill> {
        val raw = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null) ?: return emptyList()
        return decode(raw)
    }

    fun write(context: Context, rows: List<JournalFill>) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, encode(rows)).apply()
    }

    fun encode(rows: List<JournalFill>): String {
        val array = JSONArray()
        for (row in rows) {
            array.put(
                JSONObject()
                    .put("signature", row.signature)
                    .put("wallet", row.wallet)
                    .put("mint", row.mint)
                    .put("symbol", row.symbol)
                    .put("side", row.side)
                    .put("venue", row.venue)
                    .put("solLamports", row.solLamports)
                    .put("tokenAmount", row.tokenAmount)
                    .put("feeLamports", row.feeLamports)
                    .put("marketCapLamports", row.marketCapLamports)
                    .put("priceLamportsPerToken", row.priceLamportsPerToken)
                    .put("timestamp", row.timestamp)
                    .put("outcome", row.outcome)
                    .put("realizedPnlLamports", row.realizedPnlLamports ?: JSONObject.NULL)
                    .put("costBasisReason", row.costBasisReason)
            )
        }
        return array.toString()
    }

    fun decode(raw: String): List<JournalFill> {
        val array = JSONArray(raw)
        return buildList {
            for (i in 0 until array.length()) {
                val row = array.getJSONObject(i)
                val pnl = row.opt("realizedPnlLamports")
                add(
                    JournalFill(
                        signature = row.optString("signature"),
                        wallet = row.optString("wallet"),
                        mint = row.optString("mint"),
                        symbol = row.optString("symbol"),
                        side = row.optString("side"),
                        venue = row.optString("venue"),
                        solLamports = row.optString("solLamports"),
                        tokenAmount = row.optString("tokenAmount"),
                        feeLamports = row.optString("feeLamports"),
                        marketCapLamports = row.optString("marketCapLamports"),
                        priceLamportsPerToken = row.optString("priceLamportsPerToken"),
                        timestamp = row.optLong("timestamp"),
                        outcome = row.optString("outcome"),
                        realizedPnlLamports = if (pnl == null || pnl == JSONObject.NULL) null else pnl.toString(),
                        costBasisReason = row.optString("costBasisReason")
                    )
                )
            }
        }
    }
}
