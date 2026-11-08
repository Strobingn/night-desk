package com.dirk.nightdesk.pump

import android.content.Context
import com.dirk.nightdesk.wallet.MwaSigner
import com.dirk.nightdesk.wallet.SecureStore
import com.dirk.nightdesk.wallet.TxGuard
import com.dirk.nightdesk.wallet.WalletSession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.math.BigInteger
import javax.crypto.KeyGenerator
import kotlin.math.abs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TerminalTest {
    private val cap = BigInteger("5000000")
    private val wallet = "9uKZa19zhtu6q8gtVkLmYzAERL6NWSxTYPp2XdxZ8NZT"
    private val okTx = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAIEhESvYTMTK5Jb6VmXbFsz2B5a54BPD5zu+Cku3DEBLMawFpc6TpRgY5pvx+fMgSzA75/SB1j6sZJsgpNNODn3zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwIDAAUCQA0DAAICAAEMAgAAAOgDAAAAAAAA"
    private val unknownTx = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEChESvYTMTK5Jb6VmXbFsz2B5a54BPD5zu+Cku3DEBLMYFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHAQEAAQE="
    private val fatTx = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEDhESvYTMTK5Jb6VmXbFsz2B5a54BPD5zu+Cku3DEBLMawFpc6TpRgY5pvx+fMgSzA75/SB1j6sZJsgpNNODn3zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcBAgIAAQwCAAAAAJQ1dwAAAAA="

    @Test
    fun canonicalCurveMatchesGraduationNumbersAndReverseQuote() {
        val reserves = CurveMath.canonical()
        assertEquals(0.0, CurveMath.progressPct(reserves)!!, 0.001)
        val dust = reserves.copy(
            virtualTokenReserves = BigInteger("500000000000000"),
            realTokenReserves = BigInteger("400000000000000"),
            realQuoteReserves = BigInteger.ONE
        )
        assertEquals(null, CurveMath.progressPct(dust))
        assertEquals(BigInteger("85005359057"), CurveMath.solRemaining(reserves))
        val mcapSol = CurveMath.marketCap(reserves).toDouble() / 1e9
        assertTrue(abs(mcapSol - 27.96) < 0.02)
        val gradSol = CurveMath.graduationMarketCap(reserves).toDouble() / 1e9
        assertTrue(abs(gradSol - 410.9) < 0.2)
        val target = CurveMath.marketCap(reserves).multiply(BigInteger.TWO)
        val quote = CurveMath.solToReachMarketCap(reserves, target)
        assertTrue(quote.reachable)
        assertTrue(quote.solNeededLamports.signum() > 0)
        val gap = quote.marketCapLamports.subtract(target).toDouble() / target.toDouble()
        assertTrue(gap >= 0 && gap < 0.005)
    }

    @Test
    fun guardRejectsForeignPayerUnknownProgramAndOverCap() {
        val guard = TxGuard()
        assertEquals(32, "11111111111111111111111111111111".length)
        assertEquals("11111111111111111111111111111111", TxGuard.encodeBase58(ByteArray(32)))
        val ok = guard.inspect(okTx, wallet, BigInteger("1000"), cap)
        assertTrue(ok.ok)
        val foreign = guard.inspect(okTx, "CrNjajS5MWceW1Hu6M8mesf4bHGF5GC8CteeShTyCz91", BigInteger("1000"), cap)
        assertFalse(foreign.ok)
        assertEquals("FOREIGN_FEE_PAYER", foreign.code)
        val unknown = guard.inspect(unknownTx, wallet, BigInteger.ONE, cap)
        assertEquals("UNKNOWN_PROGRAM", unknown.code)
        val over = guard.inspect(okTx, wallet, cap.add(BigInteger.ONE), cap)
        assertEquals("OVER_CAP", over.code)
        val fat = guard.inspect(fatTx, wallet, BigInteger.ONE, cap)
        assertEquals("OVER_CAP", fat.code)
    }

    @Test
    fun simulateModeNeverOpensTheWallet() = runBlocking {
        var opens = 0
        val session = object : WalletSession {
            override val pubkey: String = wallet
            override suspend fun connect() = wallet
            override suspend fun sign(unsigned: ByteArray): ByteArray {
                opens += 1
                return unsigned
            }
        }
        val signer = MwaSigner(session)
        val simulated = signer.approve(okTx, wallet, BigInteger("1000"), cap, simulateOnly = true)
        assertFalse(simulated.opened)
        assertEquals("SIMULATED", simulated.code)
        assertEquals(0, opens)
        val blocked = signer.approve(okTx, "CrNjajS5MWceW1Hu6M8mesf4bHGF5GC8CteeShTyCz91", BigInteger("1000"), cap, simulateOnly = false)
        assertFalse(blocked.opened)
        assertEquals(0, opens)
        val live = signer.approve(okTx, wallet, BigInteger("1000"), cap, simulateOnly = false)
        assertTrue(live.opened)
        assertEquals("SIGNED", live.code)
        assertEquals(1, opens)
    }

    @Test
    fun secureStoreRoundTripsCiphertext() {
        val context = RuntimeEnvironment.getApplication() as Context
        val prefs = context.getSharedPreferences("pump-secure-test", Context.MODE_PRIVATE)
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val store = SecureStore.forTest(prefs, key)
        val pubkey = "So11111111111111111111111111111111111111112"
        store.saveWalletPubkey(pubkey)
        store.saveSettings("""{"mint":"abc"}""")
        val raw = prefs.getString(SecureStore.WALLET, "")!!
        assertFalse(raw.contains("So111"))
        assertNotEquals(pubkey, raw)
        assertEquals(pubkey, store.walletPubkey())
        assertEquals("""{"mint":"abc"}""", store.settings())
    }

    @Test
    fun priceAlertFiresAtTheTargetAndNamesAPeriodicWatch() {
        assertFalse(shouldAlert(BigInteger("10"), BigInteger("11")))
        assertTrue(shouldAlert(BigInteger("11"), BigInteger("11")))
        assertFalse(shouldAlert(BigInteger("11"), BigInteger.ZERO))
        assertEquals("pump-price-Mint", priceAlertWorkName("Mint"))
        assertEquals(BigInteger("1500000000"), solToLamports("1.5"))
    }
}
