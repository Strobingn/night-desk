package com.dirk.nightdesk

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.util.concurrent.TimeUnit

/**
 * Public Supabase read of the desk's current quick-tunnel URL.
 * The anon key is the public client role for SELECT on night_desk_beacon.
 * It cannot write the row. The desk PATCH uses a service-role key that stays off the phone.
 */
object DeskBeacon {
    const val ENDPOINT =
        "https://qivqvwlrmrgjpiqgvmzy.supabase.co/rest/v1/night_desk_beacon?id=eq.phone&select=public_url"
    const val ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpdnF2d2xybXJnanBpcWd2bXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMzM2MzYsImV4cCI6MjEwNzkwOTYzNn0.QZ5eaP0a-9masw5X8y24ivAoKoAvFisdz0OC8ThueOI"
    const val LAN_URL = "http://192.168.1.242:4721"
    /** Used when the beacon row is empty and nothing else has worked. */
    const val DEFAULT_PUBLIC_URL = "https://fever-solved-permissions-variations.trycloudflare.com"

    private val http = OkHttpClient.Builder()
        .callTimeout(8, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    fun fetchPublicUrl(): String? {
        val request = Request.Builder()
            .url(ENDPOINT)
            .header("apikey", ANON_KEY)
            .header("Authorization", "Bearer $ANON_KEY")
            .header("accept", "application/json")
            .build()
        http.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("beacon HTTP ${response.code}")
            return parsePublicUrl(body)
        }
    }

    fun parsePublicUrl(body: String): String? {
        val rows = JSONArray(body)
        if (rows.length() == 0) return null
        val url = rows.getJSONObject(0).optString("public_url").trim().trimEnd('/')
        if (!url.startsWith("https://") && !url.startsWith("http://")) return null
        return url
    }
}
