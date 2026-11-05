package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Real /api/state and /api/recap shapes, including the nulls that used to crash the phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeskParsersTest {
    @Test
    fun stateShapeSurvivesNullsDuplicateIdsAndAWrappedSocketFrame() {
        val snap = parseDeskPayload(STATE_JSON)
        assertNotNull(snap)
        snap!!
        assertEquals("paper", snap.mode)
        assertEquals(100.0, snap.equityUsd, 0.0)
        assertEquals(92.0, snap.cashUsd, 0.0)
        assertEquals(0.06, snap.stopLossPct, 0.0)
        assertEquals(0.03, snap.maxEntrySlippage, 0.0)
        assertEquals(8.0, snap.defaultBuyUsd!!, 0.0)
        assertEquals(2, snap.positions.size)
        assertEquals("MintA", snap.positions[0].mint)
        assertEquals("MintA#2", snap.positions[1].mint)
        assertEquals(0.0, snap.positions[0].entryPrice, 0.0)
        assertEquals(0.0, snap.positions[0].score, 0.0)
        assertEquals(4, snap.events.size)
        assertEquals(4, snap.events.map { it.id }.toSet().size)
        assertEquals(1, snap.closed.size)
        assertEquals("STOP", snap.closed[0].exitCode)
        assertEquals(1, snap.advice.size)
        assertEquals("near-miss", snap.advice[0].stance)
        assertEquals("MintA", snap.advice[0].mint)
        assertTrue(snap.readiness?.lines?.contains("Still paper") == true)
        assertEquals(0.0, snap.positions[0].stopDistancePct, 0.0)

        val wrapped = parseDeskPayload("""{"type":"snapshot","data":$STATE_JSON}""")
        assertEquals(snap.equityUsd, wrapped!!.equityUsd, 0.0)
        assertNull(parseDeskPayload("{"))
        assertNull(parseDeskPayload("""{"type":"snapshot","data":{}}"""))
    }

    @Test
    fun recapShapeAllowsNullClosedNullCountAndAnEmptyList() {
        val missing = parseRecap(
            """{"text":"Starting equity $100.00","closed":null,"closedCount":null,"startingEquity":100,"pnlUsd":null,"winRate":null}"""
        )
        assertNotNull(missing)
        assertEquals("Starting equity $100.00", missing!!.text)
        assertTrue(missing.closed.isEmpty())
        assertEquals(0, missing.closedCount)
        assertEquals(100.0, missing.startingEquity, 0.0)
        assertEquals(0.0, missing.pnlUsd, 0.0)

        val empty = parseRecap(RECAP_JSON)
        assertEquals(0, empty!!.closedCount)
        assertTrue(empty.closed.isEmpty())
        assertTrue(empty.text.contains("Recent closes"))

        val one = parseRecap(
            """{"text":"","closedCount":4,"startingEquity":"nope","pnlUsd":-1.5,"closed":[{"id":null,"symbol":null,"exitCode":"STOP","closedAt":1700000000000,"entryPrice":null,"exitPrice":0.00000001,"pnlUsd":-1.5}]}"""
        )
        assertEquals("No recap text.", one!!.text)
        assertEquals(4, one.closedCount)
        assertEquals(1, one.closed.size)
        assertEquals("trade-0", one.closed[0].id)
        assertEquals("—", one.closed[0].symbol)
        assertEquals(0.0, one.startingEquity, 0.0)
        assertNull(parseRecap("not-json"))
        assertNull(parseRecap(""))
    }

    @Test
    fun moneyAndNaNDoNotThrow() {
        assertEquals("$0.00", formatUsd(Double.NaN))
        assertEquals("$0.00", formatUsd(null))
        assertEquals("$100.00", formatUsd(100.0))
    }

    private companion object {
        val STATE_JSON = """
            {
              "mode": "paper",
              "cashUsd": 92,
              "equityUsd": 100,
              "sessionPnlUsd": 0,
              "rules": {
                "minVolume1hUsd": 10000,
                "analystMinScore": 0.5,
                "maxTop10Pct": 0.35,
                "maxPositionPct": 0.08,
                "stopLossPct": 0.06,
                "maxEntrySlippage": 0.03
              },
              "prefs": { "defaultBuyUsd": 8, "maxOpenPositions": 12, "allowUnlockedLp": true },
              "positionCapUsd": 8,
              "cooldowns": [{ "mint": null, "until": null, "minutesLeft": null }, { "mint": "MintA", "until": 1700000000000, "minutesLeft": 12 }],
              "readiness": { "mode": "paper", "liveTradingFlag": false, "keypairPresent": false, "walletPublicKey": null, "rpcPresent": true, "operatorReady": false, "lines": ["Still paper", null] },
              "advice": [{ "id": null, "stance": "near-miss", "text": "Volume is close", "symbol": "HOOF", "mint": "MintA", "code": "MIN_VOLUME", "score": null }],
              "positions": [
                { "mint": "MintA", "symbol": "HOOF", "pnlUsd": null, "pnlPct": null, "markPrice": 0, "stopPrice": null, "entryPrice": null, "score": null, "source": "pump", "entry": "analyst", "lpUnlocked": false, "markAgeMs": null },
                { "mint": "MintA", "symbol": "HOOF", "pnlUsd": 1, "pnlPct": 0.1, "markPrice": 1.1, "stopPrice": 1.0, "entryPrice": 1, "score": 0.5, "source": "pump", "entry": "manual", "lpUnlocked": true, "markAgeMs": 4000 }
              ],
              "events": [
                { "id": "tape", "ts": 1, "stage": "scout", "kind": "info", "message": "one", "code": null, "mint": "MintA", "symbol": "HOOF" },
                { "id": "tape", "ts": 2, "stage": "risk", "kind": "exit", "message": "two" },
                { "id": null, "ts": 3, "stage": "system", "kind": "info", "message": "three" },
                { "ts": null, "message": null }
              ],
              "closed": [
                { "id": "trade-1", "symbol": "HOOF", "exitCode": "STOP", "closedAt": 1700000000000, "entryPrice": 0.00005607, "exitPrice": 0.00000003805, "pnlUsd": -7 }
              ]
            }
        """.trimIndent()

        val RECAP_JSON = """
            {
              "since": 1700000000000,
              "until": 1700003600000,
              "startingEquity": 100,
              "endingEquity": 100,
              "pnlUsd": 0,
              "pnlPct": 0,
              "closedCount": 0,
              "closed": [],
              "winCount": 0,
              "lossCount": 0,
              "breakevenCount": 0,
              "winRate": null,
              "open": [],
              "filterKills": 0,
              "filterPasses": 0,
              "killReasons": {},
              "analystRejects": 0,
              "executorSkips": {},
              "riskExits": {},
              "scouted": 0,
              "text": "Starting equity ${'$'}100.00\nRecent closes: last 50 of 0"
            }
        """.trimIndent()
    }
}
