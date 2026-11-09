package com.dirk.nightdesk.pump

import android.os.Looper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PumpApiThreadTest {
    private val okBody = """{"ok":true,"armed":false,"caps":{"tradeLamports":"1"},"curve":{"mint":"m","marketCapLamports":"1","virtualTokenReserves":"1","virtualQuoteReserves":"1","realTokenReserves":"1","realQuoteReserves":"1","tokenTotalSupply":"1"},"trades":[],"intent":{"solLamports":"1","simulateOnly":true,"feePayer":"w","mode":"simulate"}}"""

    @Test
    fun watchAndReadsLeaveTheCallerAndTheMainLooper() = runBlocking {
        val caller = Thread.currentThread()
        var seen: Thread? = null
        val client = OkHttpClient.Builder().addInterceptor {
            seen = Thread.currentThread()
            ok(it.request(), 200, okBody)
        }.build()
        val api = PumpApi(client)
        api.watch("http://desk.invalid", "tok", "Mint")
        api.status("http://desk.invalid", "tok")
        api.fetchCurve("http://desk.invalid", "tok", "Mint")
        api.trades("http://desk.invalid", "tok", "Mint")
        api.prepare("http://desk.invalid", "tok", "w", "Mint", "1", false)
        val thread = seen
        assertNotEquals(null, thread)
        assertNotEquals(caller.id, thread!!.id)
        assertNotEquals(Looper.getMainLooper().thread.id, thread.id)
    }

    @Test
    fun watchSurfacesTheServerError() = runBlocking {
        val client = OkHttpClient.Builder().addInterceptor {
            ok(it.request(), 503, """{"error":"curve down"}""")
        }.build()
        val message = runCatching { PumpApi(client).watch("http://desk.invalid", "", "Mint") }.exceptionOrNull()?.message
        assertEquals("curve down", message)
    }

    @Test
    fun statusSwallowsHttpFailureButNotCancellation() = runBlocking {
        val failed = OkHttpClient.Builder().addInterceptor {
            ok(it.request(), 500, """{"error":"curve down"}""")
        }.build()
        assertEquals(null, PumpApi(failed).status("http://desk.invalid", "tok"))
        val cancelled = OkHttpClient.Builder().addInterceptor {
            throw CancellationException("left the pump tab")
        }.build()
        val thrown = runCatching { PumpApi(cancelled).status("http://desk.invalid", "tok") }.exceptionOrNull()
        assertTrue(thrown is CancellationException)
    }

    private fun ok(request: okhttp3.Request, code: Int, body: String): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message("ok")
        .body(body.toResponseBody())
        .build()
}
