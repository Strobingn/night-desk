package com.dirk.nightdesk

import org.json.JSONObject

data class AdviceNote(
    val id: String,
    val stance: String,
    val text: String,
    val symbol: String?
)

data class PositionRow(
    val mint: String,
    val symbol: String,
    val pnlUsd: Double,
    val pnlPct: Double,
    val markPrice: Double,
    val stopPrice: Double,
    val entryPrice: Double,
    val score: Double
) {
    val stopDistancePct: Double
        get() = if (markPrice > 0) ((markPrice - stopPrice) / markPrice) * 100.0 else 0.0
}

data class TapeEvent(
    val id: String,
    val ts: Long,
    val stage: String,
    val kind: String,
    val message: String,
    val code: String?
)

data class DeskSnapshot(
    val mode: String,
    val cashUsd: Double,
    val equityUsd: Double,
    val sessionPnlUsd: Double,
    val minVolume1hUsd: Double,
    val advice: List<AdviceNote>,
    val positions: List<PositionRow>,
    val events: List<TapeEvent>
)

fun parseDeskPayload(raw: String): DeskSnapshot? {
    val root = JSONObject(raw)
    val data = when {
        root.has("equityUsd") -> root
        root.optJSONObject("data") != null -> root.getJSONObject("data")
        else -> return null
    }
    if (!data.has("equityUsd")) return null
    val rules = data.optJSONObject("rules")
    val advice = data.optJSONArray("advice")
    val positions = data.optJSONArray("positions")
    val events = data.optJSONArray("events")
    val notes = buildList {
        if (advice != null) {
            for (i in 0 until advice.length()) {
                val row = advice.optJSONObject(i) ?: continue
                add(
                    AdviceNote(
                        id = row.optString("id", "advice-$i"),
                        stance = row.optString("stance", "watch"),
                        text = row.optString("text"),
                        symbol = row.optString("symbol").ifBlank { null }
                    )
                )
            }
        }
    }
    val book = buildList {
        if (positions != null) {
            for (i in 0 until positions.length()) {
                val row = positions.optJSONObject(i) ?: continue
                add(
                    PositionRow(
                        mint = row.optString("mint"),
                        symbol = row.optString("symbol", "—"),
                        pnlUsd = row.optDouble("pnlUsd"),
                        pnlPct = row.optDouble("pnlPct"),
                        markPrice = row.optDouble("markPrice"),
                        stopPrice = row.optDouble("stopPrice"),
                        entryPrice = row.optDouble("entryPrice"),
                        score = row.optDouble("score")
                    )
                )
            }
        }
    }
    val tape = buildList {
        if (events != null) {
            for (i in 0 until events.length()) {
                val row = events.optJSONObject(i) ?: continue
                add(
                    TapeEvent(
                        id = row.optString("id", "event-$i"),
                        ts = row.optLong("ts"),
                        stage = row.optString("stage", "system"),
                        kind = row.optString("kind", "info"),
                        message = row.optString("message"),
                        code = row.optString("code").ifBlank { null }
                    )
                )
            }
        }
    }
    return DeskSnapshot(
        mode = data.optString("mode", "paper"),
        cashUsd = data.optDouble("cashUsd"),
        equityUsd = data.optDouble("equityUsd"),
        sessionPnlUsd = data.optDouble("sessionPnlUsd"),
        minVolume1hUsd = rules?.optDouble("minVolume1hUsd", 50_000.0) ?: 50_000.0,
        advice = notes,
        positions = book,
        events = tape
    )
}
