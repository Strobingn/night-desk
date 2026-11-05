package com.dirk.nightdesk

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

private val Context.deskStore by preferencesDataStore(name = "night_desk")

data class DeskLink(val baseUrl: String, val token: String)

class DeskRepository(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()

    private val _snapshot = MutableStateFlow<DeskSnapshot?>(null)
    val snapshot: StateFlow<DeskSnapshot?> = _snapshot
    private val _status = MutableStateFlow("Set the desk URL")
    val status: StateFlow<String> = _status
    private val _live = MutableStateFlow(false)
    val live: StateFlow<Boolean> = _live
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private val tape = LinkedHashMap<String, TapeEvent>()
    private var socket: WebSocket? = null
    private var reconnecting = false
    private var poll: Job? = null
    private var link = DeskLink("", "")

    suspend fun currentLink(): DeskLink {
        val prefs = context.deskStore.data.first()
        return DeskLink(
            baseUrl = prefs[KEY_URL].orEmpty(),
            token = prefs[KEY_TOKEN].orEmpty()
        )
    }

    suspend fun saveLink(baseUrl: String, token: String) {
        context.deskStore.edit { prefs ->
            prefs[KEY_URL] = baseUrl.trim().trimEnd('/')
            prefs[KEY_TOKEN] = token.trim()
        }
        start(baseUrl.trim().trimEnd('/'), token.trim())
    }

    fun start(baseUrl: String, token: String) {
        link = DeskLink(baseUrl.trim().trimEnd('/'), token.trim())
        poll?.cancel()
        socket?.close(1000, "reconnect")
        socket = null
        if (link.baseUrl.isBlank()) {
            _status.value = "Set the desk URL"
            _live.value = false
            return
        }
        _status.value = "Connecting"
        openSocket()
        poll = scope.launch {
            while (isActive) {
                refresh()
                delay(3_000)
            }
        }
    }

    suspend fun refresh() {
        val base = link.baseUrl
        if (base.isBlank()) return
        val result = get("$base/api/state")
        result.onSuccess { body ->
            parseDeskPayload(body)?.let { apply(it) }
            _error.value = null
        }.onFailure { err ->
            _error.value = err.message ?: "Desk did not answer"
        }
    }

    suspend fun closePosition(mint: String): Result<Unit> {
        val base = link.baseUrl
        if (base.isBlank()) return Result.failure(IllegalStateException("No desk URL"))
        return post("$base/api/positions/close", JSONObject().put("mint", mint).toString()).map { }
            .also { refresh() }
    }

    suspend fun resetPaperBook(): Result<Double> {
        val base = link.baseUrl
        if (base.isBlank()) return Result.failure(IllegalStateException("No desk URL"))
        val result = post("$base/api/paper/reset", JSONObject().put("confirm", true).toString())
        return result.map { body ->
            val cash = JSONObject(body).optDouble("cashUsd", 100.0)
            refresh()
            cash
        }
    }

    suspend fun setMinVolume(usd: Double): Result<Double> {
        val base = link.baseUrl
        if (base.isBlank()) return Result.failure(IllegalStateException("No desk URL"))
        val result = post("$base/api/settings", JSONObject().put("minVolume1hUsd", usd).toString())
        return result.map { body ->
            val value = JSONObject(body).optDouble("minVolume1hUsd", usd)
            refresh()
            value
        }
    }

    private fun apply(next: DeskSnapshot) {
        for (event in next.events) tape[event.id] = event
        while (tape.size > 800) {
            val oldest = tape.keys.firstOrNull() ?: break
            tape.remove(oldest)
        }
        _snapshot.value = next.copy(events = tape.values.sortedBy { it.ts })
        if (_status.value == "Connecting") _status.value = "Live"
    }

    private fun openSocket() {
        val base = link.baseUrl
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> "ws://$base"
        }
        val token = link.token
        val query = if (token.isBlank()) "" else "?token=" + URLEncoder.encode(token, Charsets.UTF_8.name())
        val request = Request.Builder()
            .url("$wsBase/ws$query")
            .apply { if (token.isNotBlank()) header("X-Desk-Token", token) }
            .build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                _live.value = true
                _status.value = "Live"
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                parseDeskPayload(text)?.let { apply(it) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                _live.value = false
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _live.value = false
                _status.value = "Reconnecting"
                _error.value = t.message
                if (reconnecting) return
                reconnecting = true
                scope.launch {
                    delay(2_000)
                    reconnecting = false
                    if (link.baseUrl.isNotBlank()) openSocket()
                }
            }
        })
    }

    private suspend fun get(url: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(withToken(url)).authed().build()
            http.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) error("HTTP ${response.code}")
                body
            }
        }
    }

    private suspend fun post(url: String, json: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(withToken(url))
                .authed()
                .post(json.toRequestBody(JSON))
                .build()
            http.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val message = runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty()
                    error(message.ifBlank { "HTTP ${response.code}" })
                }
                body
            }
        }
    }

    private fun withToken(url: String): String {
        val token = link.token
        if (token.isBlank() || url.contains("token=")) return url
        val join = if (url.contains("?")) "&" else "?"
        return url + join + "token=" + URLEncoder.encode(token, Charsets.UTF_8.name())
    }

    private fun Request.Builder.authed(): Request.Builder {
        val token = link.token
        header("accept", "application/json")
        if (token.isNotBlank()) header("X-Desk-Token", token)
        return this
    }

    companion object {
        private val KEY_URL = stringPreferencesKey("base_url")
        private val KEY_TOKEN = stringPreferencesKey("desk_token")
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
