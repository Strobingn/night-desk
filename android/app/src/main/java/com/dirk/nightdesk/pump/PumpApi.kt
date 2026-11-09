package com.dirk.nightdesk.pump

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import org.json.JSONObject
import java.math.BigInteger
import java.util.concurrent.TimeUnit

data class CurveView(
    val mint: String,
    val marketCapLamports: BigInteger,
    val progressPct: Double?,
    val solInCurveLamports: BigInteger?,
    val solRemainingLamports: BigInteger?,
    val graduationMarketCapLamports: BigInteger?,
    val virtualTokenReserves: BigInteger,
    val virtualQuoteReserves: BigInteger,
    val realTokenReserves: BigInteger,
    val realQuoteReserves: BigInteger,
    val tokenTotalSupply: BigInteger,
    val complete: Boolean,
    val quoteIsSol: Boolean = true
) {
    fun reserves(): CurveMath.Reserves = CurveMath.Reserves(
        virtualTokenReserves, virtualQuoteReserves, realTokenReserves, realQuoteReserves, tokenTotalSupply, complete
    )
}

data class TapePrint(val id: String, val isBuy: Boolean, val solLamports: String, val user: String)

data class TapePage(val prints: List<TapePrint>, val note: String?)

data class PreparedBuy(
    val unsignedTx: String?,
    val solLamports: String,
    val simulateOnly: Boolean,
    val feePayer: String,
    val simulationOk: Boolean?
)

data class PumpStatus(val armed: Boolean, val tradeCapLamports: String)

/** HTTP client for the pump core routes the terminal already has. Blocking calls run on Dispatchers.IO. */
class PumpApi(private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(12, TimeUnit.SECONDS).build()) {
    suspend fun status(base: String, token: String): PumpStatus? = offMain {
        val json = JSONObject(get(base, token, "/api/pump/status"))
        val caps = json.optJSONObject("caps")
        PumpStatus(json.optBoolean("armed"), caps?.optString("tradeLamports") ?: "5000000")
    }

    suspend fun fetchCurve(base: String, token: String, mint: String): CurveView? = offMain {
        parseCurve(JSONObject(get(base, token, "/api/pump/curve?mint=${enc(mint)}")).getJSONObject("curve"))
    }

    suspend fun trades(base: String, token: String, mint: String): TapePage = offMain {
        val json = JSONObject(get(base, token, "/api/pump/trades?mint=${enc(mint)}&limit=40"))
        val arr = json.optJSONArray("trades")
        val prints = buildList {
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val row = arr.getJSONObject(i)
                    add(
                        TapePrint(
                            id = row.optString("signature").ifBlank { "${row.optLong("timestamp")}:${row.optString("user")}:$i" },
                            isBuy = row.optBoolean("isBuy"),
                            solLamports = row.optString("solAmountLamports", "0"),
                            user = row.optString("user")
                        )
                    )
                }
            }
        }
        TapePage(prints, json.optJSONObject("tape")?.optString("reason")?.ifBlank { null })
    } ?: TapePage(emptyList(), null)

    suspend fun watch(base: String, token: String, mint: String) {
        withContext(Dispatchers.IO) {
            post(base, token, "/api/pump/watch", JSONObject().put("mint", mint).toString())
        }
    }

    suspend fun prepare(base: String, token: String, wallet: String, mint: String, solLamports: String, live: Boolean): PreparedBuy? = offMain {
        val body = JSONObject()
            .put("wallet", wallet)
            .put("mint", mint)
            .put("side", "buy")
            .put("venue", "curve")
            .put("solLamports", solLamports)
            .put("live", live)
            .toString()
        val json = JSONObject(post(base, token, "/api/pump/prepare", body))
        val intent = json.getJSONObject("intent")
        val sim = intent.optJSONObject("simulation")
        PreparedBuy(
            unsignedTx = intent.optString("unsignedTx").ifBlank { null },
            solLamports = intent.optString("solLamports", solLamports),
            simulateOnly = intent.optBoolean("simulateOnly", true) || intent.optString("mode") == "simulate",
            feePayer = intent.optString("feePayer", wallet),
            simulationOk = if (sim == null) null else sim.optBoolean("ok")
        )
    }

    /** Null on a transport or HTTP failure. Cancellation still cancels the caller. */
    private suspend fun <T> offMain(block: () -> T): T? = withContext(Dispatchers.IO) {
        try {
            block()
        } catch (err: CancellationException) {
            throw err
        } catch (_: Exception) {
            null
        }
    }

    fun openCurveSocket(base: String, token: String, mint: String, onText: (String) -> Unit): WebSocket {
        val wsBase = base.trimEnd('/').replaceFirst(Regex("^http"), "ws")
        val url = if (token.isBlank()) "$wsBase/ws" else "$wsBase/ws?token=${enc(token)}"
        val request = Request.Builder().url(url).build()
        return http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"op":"subscribe","topic":"pump.coin","mint":"$mint"}""")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                onText(text)
            }
        })
    }

    private fun get(base: String, token: String, path: String): String {
        val req = Request.Builder().url(base.trimEnd('/') + path).headers(token).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("HTTP ${res.code}")
            return text
        }
    }

    private fun post(base: String, token: String, path: String, json: String): String {
        val req = Request.Builder()
            .url(base.trimEnd('/') + path)
            .headers(token)
            .post(json.toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) error(JSONObject(text.ifBlank { "{}" }).optString("error", "HTTP ${res.code}"))
            return text
        }
    }

    private fun Request.Builder.headers(token: String): Request.Builder {
        if (token.isNotBlank()) header("X-Desk-Token", token)
        return this
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun parseCurve(json: JSONObject): CurveView = CurveView(
            mint = json.optString("mint"),
            marketCapLamports = big(json, "marketCapLamports"),
            progressPct = if (!json.has("progressPct") || json.isNull("progressPct")) null else json.optDouble("progressPct"),
            solInCurveLamports = optionalBig(json, "solInCurveLamports"),
            solRemainingLamports = optionalBig(json, "solRemainingLamports"),
            graduationMarketCapLamports = optionalBig(json, "graduationMarketCapLamports"),
            virtualTokenReserves = big(json, "virtualTokenReserves"),
            virtualQuoteReserves = big(json, "virtualQuoteReserves"),
            realTokenReserves = big(json, "realTokenReserves"),
            realQuoteReserves = big(json, "realQuoteReserves"),
            tokenTotalSupply = big(json, "tokenTotalSupply"),
            complete = json.optBoolean("complete"),
            quoteIsSol = if (json.has("quoteIsSol")) json.optBoolean("quoteIsSol") else true
        )

        private fun big(json: JSONObject, name: String): BigInteger = json.optString(name, "0").toBigIntegerOrNull() ?: BigInteger.ZERO

        private fun optionalBig(json: JSONObject, name: String): BigInteger? {
            if (!json.has(name) || json.isNull(name)) return null
            val text = json.optString(name, "")
            if (text.isBlank()) return null
            return text.toBigIntegerOrNull()
        }
        private fun enc(value: String) = java.net.URLEncoder.encode(value, Charsets.UTF_8)
    }
}
