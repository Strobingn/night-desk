package com.dirk.nightdesk

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.io.InterruptedIOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private val Context.deskStore by preferencesDataStore(name = "night_desk")

data class DeskLink(val baseUrl: String, val token: String, val useManual: Boolean = false)

data class ResolvedDesk(val baseUrl: String, val source: String)

class DeskRepository private constructor(private val context: Context) {
    private val crashHandler = CoroutineExceptionHandler { _, error ->
        if (error is CancellationException) return@CoroutineExceptionHandler
        CrashLog.write(context, Thread.currentThread(), error)
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + crashHandler)
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()
    private val probeHttp = OkHttpClient.Builder()
        .callTimeout(2, TimeUnit.SECONDS)
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()
    /** Recap bodies used to be tens of KB. Give the read room past the 12s state poll. */
    private val recapHttp = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val _snapshot = MutableStateFlow<DeskSnapshot?>(null)
    val snapshot: StateFlow<DeskSnapshot?> = _snapshot
    private val _status = MutableStateFlow("Set the desk URL")
    val status: StateFlow<String> = _status
    private val _live = MutableStateFlow(false)
    val live: StateFlow<Boolean> = _live
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error
    private val _notice = MutableStateFlow<DeskNotice?>(null)
    val notice: StateFlow<DeskNotice?> = _notice

    fun dismissNotice() {
        _notice.value = null
    }
    private val _activeUrl = MutableStateFlow("")
    val activeUrl: StateFlow<String> = _activeUrl
    private val _linkSource = MutableStateFlow("beacon")
    val linkSource: StateFlow<String> = _linkSource

    private val tape = LinkedHashMap<String, TapeEvent>()
    private val tapeLock = Any()
    private val connectLock = Mutex()
    private val gate = Any()
    private var socket: WebSocket? = null
    private var reconnecting = false
    private var poll: Job? = null
    @Volatile private var link = DeskLink("", "")
    private val generation = AtomicInteger(0)
    private var pollMisses = 0
    private var backoffMs = 1_000L
    private var reconnectJob: Job? = null
    private var persistedGood: String? = null
    private var networkRegistered = false
    private var lastPersistAt = 0L

    suspend fun currentLink(): DeskLink {
        val prefs = context.deskStore.data.first()
        return DeskLink(
            baseUrl = prefs[KEY_URL].orEmpty(),
            token = prefs[KEY_TOKEN].orEmpty(),
            useManual = prefs[KEY_MANUAL] == true
        )
    }

    fun boot() {
        ensureNetworkCallback()
        scope.launch {
            restoreSnapshot()
            connect(afterFailure = false)
        }
    }

    /**
     * Android 15 asked the foreground service to stop. Drop the socket on a
     * background thread. A later [reconnectAfterTimeout] opens it again.
     */
    fun releaseForTimeout() {
        generation.incrementAndGet()
        val closing = synchronized(gate) {
            reconnectJob?.cancel()
            reconnecting = false
            poll?.cancel()
            poll = null
            val current = socket
            socket = null
            current
        }
        closing?.close(1000, "foreground timeout")
        _live.value = false
        _status.value = "Reconnecting"
    }

    /** WorkManager / alarm path. Reopens the book without starting a foreground service. */
    suspend fun reconnectAfterTimeout() {
        ensureNetworkCallback()
        synchronized(gate) {
            reconnectJob?.cancel()
            reconnecting = false
            backoffMs = 1_000L
        }
        connect(afterFailure = true)
    }

    /** Activity resume. A dead socket reconnects immediately instead of sitting on the abort. */
    fun onResume() {
        scope.launch {
            if (_live.value) return@launch
            reconnectJob?.cancel()
            reconnecting = false
            backoffMs = 1_000L
            connect(afterFailure = true)
        }
    }

    suspend fun saveLink(baseUrl: String, token: String, useManual: Boolean) = withContext(Dispatchers.IO) {
        val cleaned = baseUrl.trim().trimEnd('/')
        context.deskStore.edit { prefs ->
            prefs[KEY_URL] = cleaned
            prefs[KEY_TOKEN] = token.trim()
            prefs[KEY_MANUAL] = useManual
        }
        connect(afterFailure = false)
    }

    /**
     * Manual hold, then the beacon, then the saved Link URL, then LAN, then the last
     * URL that answered, then the public tunnel. Never returns a blank URL.
     */
    internal fun resolve(
        saved: DeskLink,
        beaconUrl: String?,
        lanReachable: Boolean,
        lastGood: String?,
        afterFailure: Boolean
    ): ResolvedDesk {
        val beacon = beaconUrl?.trim()?.trimEnd('/')?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        val savedUrl = saved.baseUrl.trim().trimEnd('/').ifBlank { null }
        val remembered = lastGood?.trim()?.trimEnd('/')?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        if (saved.useManual && !afterFailure && savedUrl != null) {
            return ResolvedDesk(savedUrl, "saved")
        }
        if (beacon != null && (!saved.useManual || beacon != savedUrl)) {
            return ResolvedDesk(beacon, "beacon")
        }
        if (savedUrl != null && !afterFailure) return ResolvedDesk(savedUrl, "saved")
        if (lanReachable) return ResolvedDesk(DeskBeacon.LAN_URL, "lan")
        if (savedUrl != null) return ResolvedDesk(savedUrl, "saved")
        if (beacon != null) return ResolvedDesk(beacon, "beacon")
        if (remembered != null) return ResolvedDesk(remembered, "last")
        return ResolvedDesk(DeskBeacon.DEFAULT_PUBLIC_URL, "default")
    }

    private suspend fun connect(afterFailure: Boolean) {
        val gen = generation.incrementAndGet()
        connectLock.withLock {
            if (gen != generation.get()) return@withLock
            val saved = currentLink()
            val lastGood = context.deskStore.data.first()[KEY_LAST_GOOD]
            _status.value = if (afterFailure) "Reconnecting" else "Checking the beacon"
            _error.value = null
            val beacon = runCatching { DeskBeacon.fetchPublicUrl() }.getOrNull()
            if (gen != generation.get()) return@withLock
            val lanUp = if (beacon == null) probe(DeskBeacon.LAN_URL) else false
            if (gen != generation.get()) return@withLock
            val resolved = resolve(saved, beacon, lanUp, lastGood, afterFailure)
            link = DeskLink(resolved.baseUrl, saved.token, saved.useManual)
            _activeUrl.value = resolved.baseUrl
            _linkSource.value = resolved.source
            restartTransport(gen)
        }
        if (gen == generation.get()) uploadCrash()
    }

    private fun restartTransport(gen: Int) {
        poll?.cancel()
        socket?.close(1000, "reconnect")
        socket = null
        pollMisses = 0
        _status.value = "Connecting · ${_linkSource.value}"
        openSocket(gen)
        poll = scope.launch {
            while (isActive && gen == generation.get()) {
                val ok = refresh()
                if (!ok) {
                    pollMisses += 1
                    if (pollMisses >= 3) {
                        scheduleReconnect()
                        return@launch
                    }
                } else {
                    pollMisses = 0
                    backoffMs = 1_000L
                }
                delay(3_000)
            }
        }
    }

    suspend fun refresh(): Boolean {
        val base = link.baseUrl
        if (base.isBlank()) return false
        val result = get("$base/api/state")
        result.onSuccess { body ->
            parseDeskPayload(body)?.let {
                apply(it)
                persistSnapshot(body)
            }
            _error.value = null
            rememberGood(base)
            backoffMs = 1_000L
        }.onFailure { err ->
            val message = err.message.orEmpty()
            val transport = message.contains("abort", ignoreCase = true) ||
                message.contains("socket", ignoreCase = true) ||
                message.contains("reset", ignoreCase = true) ||
                message.contains("closed", ignoreCase = true)
            if (transport) {
                _error.value = null
                _status.value = "Reconnecting"
            } else {
                _error.value = message.ifBlank { "Desk did not answer" }
            }
        }
        return result.isSuccess
    }

    private suspend fun probe(url: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url("$url/api/health").header("accept", "application/json").build()
            probeHttp.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun buyPosition(mint: String, sizeUsd: Double?, ignoreCooldown: Boolean = false): DeskNotice = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) {
            val notice = DeskNotice(false, "No desk URL")
            _notice.value = notice
            return@withContext notice
        }
        val body = JSONObject().put("mint", mint)
        if (sizeUsd != null && sizeUsd.isFinite()) body.put("sizeUsd", sizeUsd)
        if (ignoreCooldown) body.put("ignoreCooldown", true)
        val notice = post("$base/api/positions/buy", body.toString()).fold(
            onSuccess = { raw ->
                val json = runCatching { JSONObject(raw) }.getOrNull()
                if (json == null) {
                    DeskNotice(false, "Buy refused.")
                } else {
                    val ok = json.has("ok") && !json.isNull("ok") && json.optBoolean("ok", false)
                    val filled = if (json.has("sizeUsd") && !json.isNull("sizeUsd")) json.optFinite("sizeUsd", Double.NaN).takeIf { it.isFinite() } else null
                    val clamped = if (json.has("clampedFrom") && !json.isNull("clampedFrom")) json.optFinite("clampedFrom", Double.NaN).takeIf { it.isFinite() } else null
                    DeskNotice(
                        ok,
                        formatBuyNotice(
                            ok = ok,
                            error = json.optText("error").ifBlank { null },
                            symbol = json.optText("symbol").ifBlank { null },
                            sizeUsd = filled,
                            mode = json.optText("mode").ifBlank { null },
                            clampedFrom = clamped
                        )
                    )
                }
            },
            onFailure = { err ->
                DeskNotice(false, formatBuyNotice(false, err.message, null, null, null, null))
            }
        )
        _notice.value = notice
        refresh()
        notice
    }

    suspend fun saveSettings(patch: Map<String, Any?>): DeskNotice = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) {
            val notice = DeskNotice(false, "No desk URL")
            _notice.value = notice
            return@withContext notice
        }
        val body = JSONObject()
        for ((key, value) in patch) {
            if (value == null) body.put(key, JSONObject.NULL) else body.put(key, value)
        }
        val notice = post("$base/api/settings", body.toString()).fold(
            onSuccess = { raw ->
                val applied = runCatching { JSONObject(raw).optFinite("analystMinScore", Double.NaN) }.getOrNull()
                val line = if (patch.containsKey("analystMinScore") && applied != null && applied.isFinite()) {
                    "Trade line set to " + "%.2f".format(java.util.Locale.US, applied) + ". "
                } else {
                    ""
                }
                DeskNotice(true, line + "Settings saved. The −6% hard stop is unchanged.")
            },
            onFailure = { err -> DeskNotice(false, err.message ?: "Settings refused.") }
        )
        _notice.value = notice
        refresh()
        notice
    }

    suspend fun setOperatorReady(ready: Boolean): Result<Unit> = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) return@withContext Result.failure(IllegalStateException("No desk URL"))
        post("$base/api/live/ready", JSONObject().put("operatorReady", ready).toString()).map { }
            .also { refresh() }
    }

    suspend fun closePosition(mint: String): Result<Unit> = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) return@withContext Result.failure(IllegalStateException("No desk URL"))
        post("$base/api/positions/close", JSONObject().put("mint", mint).toString()).map { }
            .also { refresh() }
    }

    suspend fun resetPaperBook(): Result<Double> = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) return@withContext Result.failure(IllegalStateException("No desk URL"))
        val result = post("$base/api/paper/reset", JSONObject().put("confirm", true).toString())
        result.mapCatching { body ->
            val cash = JSONObject(body).optFinite("cashUsd", 100.0)
            refresh()
            cash
        }
    }

    suspend fun loadRecap(since: String): Result<String> = withContext(Dispatchers.IO) {
        val base = link.baseUrl
        if (base.isBlank()) return@withContext Result.failure(IllegalStateException("No desk URL"))
        val window = if (since == "12h" || since == "24h" || since == "7d" || since == "reset") since else "12h"
        runCatching {
            val request = Request.Builder()
                .url(withToken("$base/api/recap?since=$window"))
                .authed()
                .header("accept", "application/json")
                .build()
            recapHttp.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val message = runCatching { JSONObject(body).optText("error") }.getOrNull().orEmpty()
                    val detail = message.ifBlank { "Recap failed" }
                    error("$detail (HTTP ${response.code})")
                }
                val recap = parseRecap(body) ?: error("Recap failed (HTTP ${response.code})")
                recap.text
            }
        }.fold(
            onSuccess = { Result.success(it) },
            onFailure = { err ->
                if (err is CancellationException) throw err
                if (err is InterruptedIOException) Result.failure(IllegalStateException("Recap timed out after 30s"))
                else Result.failure(err)
            }
        )
    }

    suspend fun setMinVolume(usd: Double): Result<Double> {
        val base = link.baseUrl
        if (base.isBlank()) return Result.failure(IllegalStateException("No desk URL"))
        val saved = saveSettings(mapOf("minVolume1hUsd" to usd))
        return if (saved.ok) Result.success(usd) else Result.failure(IllegalStateException(saved.text))
    }

    private fun apply(next: DeskSnapshot) {
        val merged = synchronized(tapeLock) {
            for (event in next.events) {
                val id = event.id.ifBlank { "event-${event.ts}-${tape.size}" }
                tape[id] = if (event.id == id) event else event.copy(id = id)
            }
            while (tape.size > 800) {
                val oldest = tape.keys.firstOrNull() ?: break
                tape.remove(oldest)
            }
            tape.values.toList().sortedBy { it.ts }
        }
        _snapshot.value = next.copy(events = merged)
        if (_status.value.startsWith("Connecting")) _status.value = "Live · ${_linkSource.value}"
    }

    private fun openSocket(gen: Int) {
        val base = link.baseUrl
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            _status.value = "Reconnecting"
            scheduleReconnect()
            return
        }
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            else -> "ws://" + base.removePrefix("http://")
        }
        val token = link.token
        val opened = runCatching {
            val query = if (token.isBlank()) "" else "?token=" + URLEncoder.encode(token, Charsets.UTF_8.name())
            val request = Request.Builder()
                .url("$wsBase/ws$query")
                .apply { if (token.isNotBlank()) header("X-Desk-Token", token) }
                .build()
            http.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    runCatching {
                        if (gen != generation.get()) {
                            webSocket.close(1000, "stale")
                            return
                        }
                        _live.value = true
                        _error.value = null
                        _status.value = "Live · ${_linkSource.value}"
                        pollMisses = 0
                        backoffMs = 1_000L
                        rememberGood(link.baseUrl)
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    runCatching {
                        parseDeskPayload(text)?.let {
                            apply(it)
                            persistSnapshot(text)
                        }
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    runCatching {
                        webSocket.close(code, reason)
                        if (gen == generation.get()) _live.value = false
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    runCatching {
                        if (gen != generation.get()) return
                        _live.value = false
                        _error.value = null
                        _status.value = "Reconnecting"
                        scheduleReconnect()
                    }
                }
            })
        }
        opened.onSuccess { socket = it }.onFailure {
            _status.value = "Reconnecting"
            scheduleReconnect()
        }
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

    private fun rememberGood(url: String) {
        val cleaned = url.trim().trimEnd('/')
        if (cleaned.isBlank() || persistedGood == cleaned) return
        persistedGood = cleaned
        scope.launch {
            context.deskStore.edit { prefs -> prefs[KEY_LAST_GOOD] = cleaned }
        }
    }

    private fun scheduleReconnect() {
        val wait = synchronized(gate) {
            if (reconnectJob?.isActive == true || reconnecting) return
            reconnecting = true
            val pause = backoffMs
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            pause
        }
        _error.value = null
        _status.value = "Reconnecting"
        reconnectJob = scope.launch {
            try {
                delay(wait)
                connect(afterFailure = true)
            } finally {
                reconnecting = false
            }
        }
    }

    private fun ensureNetworkCallback() {
        synchronized(gate) {
            if (networkRegistered) return
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            runCatching {
                manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        runCatching {
                            if (!_live.value) {
                                reconnectJob?.cancel()
                                reconnecting = false
                                backoffMs = 1_000L
                                scope.launch { connect(afterFailure = true) }
                            }
                        }
                    }
                })
            }.onSuccess { networkRegistered = true }
        }
    }

    private fun restoreSnapshot() {
        if (_snapshot.value != null) return
        val raw = runCatching { File(context.filesDir, SNAPSHOT_FILE).readText() }.getOrNull() ?: return
        parseDeskPayload(raw)?.let { apply(it) }
    }

    private fun persistSnapshot(raw: String) {
        val now = System.currentTimeMillis()
        if (now - lastPersistAt < 5_000) return
        lastPersistAt = now
        val copy = raw
        scope.launch {
            runCatching { File(context.filesDir, SNAPSHOT_FILE).writeText(copy) }
        }
    }

    private suspend fun uploadCrash() {
        if (!CrashLog.needsUpload(context)) return
        val base = link.baseUrl
        if (base.isBlank()) return
        val stack = CrashLog.read(context) ?: return
        val body = JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("stack", stack.take(20_000))
            .toString()
        val result = post("$base/api/client-crash", body)
        if (result.isSuccess) CrashLog.markUploaded(context)
    }

    companion object {
        @Volatile
        private var instance: DeskRepository? = null

        fun get(context: Context): DeskRepository {
            return instance ?: synchronized(this) {
                instance ?: DeskRepository(context.applicationContext).also { instance = it }
            }
        }

        private val KEY_URL = stringPreferencesKey("base_url")
        private val KEY_TOKEN = stringPreferencesKey("desk_token")
        private val KEY_MANUAL = booleanPreferencesKey("use_manual_url")
        private val KEY_LAST_GOOD = stringPreferencesKey("last_good_url")
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private const val SNAPSHOT_FILE = "last-snapshot.json"
    }
}
