package com.dirk.nightdesk.journal

import com.dirk.nightdesk.DeskRepository
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder

/** Reads the desk journal. The phone does not keep a second copy of the chain. */
class PumpApi(private val context: Context) {
    private val http = OkHttpClient()

    suspend fun journal(): List<JournalFill> = withContext(Dispatchers.IO) {
        val body = get("/api/pump/journal")
        DeskCache.decode(JSONObject(body).getJSONArray("rows").toString())
    }

    suspend fun importChain(wallet: String): String = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("wallet", wallet).put("fromChain", true).toString()
        post("/api/pump/portfolio/import", payload)
    }

    private suspend fun get(path: String): String = call(Request.Builder().url(url(path)).get())

    private suspend fun post(path: String, json: String): String {
        val body = json.toRequestBody("application/json".toMediaType())
        return call(Request.Builder().url(url(path)).post(body))
    }

    private fun call(builder: Request.Builder): String {
        http.newCall(builder.header("accept", "application/json").build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error(JSONObject(text.ifBlank { "{}" }).optString("error", "HTTP ${response.code}"))
            return text
        }
    }

    private suspend fun url(path: String): String {
        val link = DeskRepository.get(context).currentLink()
        val base = link.baseUrl.trimEnd('/')
        if (base.isBlank()) error("The desk link is not set.")
        val token = URLEncoder.encode(link.token, "UTF-8")
        val join = if (path.contains("?")) "&" else "?"
        return "$base$path${join}token=$token"
    }
}
