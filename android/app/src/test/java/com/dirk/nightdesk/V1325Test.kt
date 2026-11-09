package com.dirk.nightdesk

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V1325Test {
    @Test
    fun walletDustAndSolDollars() {
        assertEquals("$0.0010", OneTap.formatBalanceUsd(0.001008))
        assertFalse(OneTap.formatBalanceUsd(0.001008) == "$0.00")
        val sol = OneTap.formatSolHolding(0.2951, 86.24)
        assertTrue(sol.startsWith("0.2951 SOL · ~$"))
        val strip = OneTap.liveCashLabel(0.2951, 86.24, 0.001008, 0.0, true, null)
        assertTrue(strip.contains("0.2951 SOL"))
        assertTrue(strip.contains("USDC $0.0010"))
        assertFalse(strip.contains("USDC $0.00"))
    }

    @Test
    fun hardKillKeepsTheReasonAndBuyAnyway() {
        val reason = "Hard kill on NEAR: mint authority is still active. Tap Buy anyway to paper-buy it regardless."
        assertEquals(reason, OneTap.hardKillReason("HARD_KILL", reason))
        assertNull(OneTap.hardKillReason("ENTRY_SLIPPAGE", reason))
        val kill = JSONObject().put("ok", false).put("error", reason).put("code", "HARD_KILL")
        val text = OneTap.buyText("NEAR", kill, false, 40)
        assertTrue(text.contains(reason))
        assertTrue(text.contains("HARD_KILL"))
        assertTrue(text.contains("Use Buy… to override"))
    }

    @Test
    fun exitImpactRefusalShowsTheCode() {
        val refused = JSONObject()
            .put("ok", false)
            .put("error", "A full exit would cost 85.13%, more than your 6.00% exit slippage setting. Sell refused.")
            .put("code", "EXIT_IMPACT")
        val text = OneTap.sellText("PAYDAY", refused, false, 30)
        assertTrue(text.contains("would cost 85.13%"))
        assertTrue(text.contains("Sell refused"))
        assertTrue(text.contains("EXIT_IMPACT"))
        assertFalse(text.contains("did not complete"))
        assertFalse(text.contains("LIVE_SWAP_FAILED"))
    }

    @Test
    fun recentGapRugKeepsEntryExitAndPnl() {
        val raw = """{"equityUsd":90,"cashUsd":80,"closed":[{"id":"g1","symbol":"JOSE","exitCode":"GAP_RUG","closedAt":1700000001000,"entryPrice":0.00012,"exitPrice":0.00004,"pnlUsd":-6.4}]}"""
        val snap = parseDeskPayload(raw)!!
        assertEquals(1, snap.closed.size)
        assertEquals("GAP_RUG", snap.closed[0].exitCode)
        assertEquals(0.00012, snap.closed[0].entryPrice, 0.0)
        assertEquals(0.00004, snap.closed[0].exitPrice, 0.0)
        assertEquals(-6.4, snap.closed[0].pnlUsd, 0.0)
        assertEquals("gap/rug", OneTap.exitLabel(snap.closed[0].exitCode))
    }
}
