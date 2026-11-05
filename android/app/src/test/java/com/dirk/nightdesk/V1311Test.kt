package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** v13.11 limit / take-profit / stop orders, the 600% trail arm, and the Link URL that follows the tunnel. */
@RunWith(RobolectricTestRunner::class)
class V1311Test {
    private val payload = """
        {"mode":"paper","cashUsd":900,"equityUsd":1000,"rules":{"trailArmPct":6,"stopLossPct":0.03},
         "orders":[
          {"id":"a","book":"paper","side":"take_profit","mint":"M1","symbol":"AAA","triggerPrice":0.0006,"fraction":0.5,"status":"open","note":null,"waiting":null,"markUsd":0.0004,"distancePct":0.5,"text":"Take profit 50% AAA"},
          {"id":"b","book":"live","side":"limit_buy","mint":"M2","symbol":"BBB","triggerPrice":0.0003,"sizeUsd":5,"status":"open","note":"waiting: live not armed","waiting":"waiting: live not armed","markUsd":null,"distancePct":null,"text":"LIVE Limit buy"},
          {"id":"c","book":"paper","side":"stop_sell","mint":"M3","symbol":"CCC","triggerPrice":0,"status":"open"},
          {"id":"d","book":"paper","side":"stop_sell","mint":"M4","symbol":"DDD","triggerPrice":0.9,"fraction":1,"status":"failed","note":"Refused: no pool (3 tries)","text":"Stop"}
         ]}
    """.trimIndent()

    @Test fun parsesOrdersAndDropsZeroTriggers() {
        val snap = parseDeskPayload(payload)!!
        assertEquals(listOf("a", "b", "d"), snap.orders.map { it.id })
        val tp = snap.orders[0]
        assertTrue(tp.isOpen)
        assertEquals(0.5, tp.fraction!!, 1e-9)
        val lb = snap.orders[1]
        assertTrue(lb.live)
        assertEquals("waiting: live not armed", OrderTicket.statusText(lb))
        assertEquals("+50.0% away", OrderTicket.statusText(tp))
        assertEquals("Refused: no pool (3 tries)", OrderTicket.statusText(snap.orders[2]))
        assertEquals(6.0, snap.trailArmPct, 1e-9)
    }

    @Test fun ticketPreviewAndBases() {
        assertEquals(listOf("pct_now", "price", "mcap"), OrderTicket.basesFor("limit_buy"))
        assertEquals("pct_entry", OrderTicket.basesFor("stop_sell").first())
        assertEquals(0.9, OrderTicket.preview("pct_now", -10.0, 1.0, null)!!, 1e-9)
        assertEquals(7.0, OrderTicket.preview("pct_entry", 600.0, 3.0, 1.0)!!, 1e-9)
        assertNull(OrderTicket.preview("mcap", 1e6, 1.0, 1.0))
        assertNull(OrderTicket.preview("pct_now", -100.0, 1.0, null))
        assertNull(OrderTicket.preview("price", 0.0, 1.0, null))
        assertEquals("-2", OrderTicket.defaultValue("stop_sell", "pct_entry"))
        assertEquals(-12.5, OrderTicket.parse("-12.5%")!!, 1e-9)
    }

    @Test fun savedTunnelUrlFollowsTheDesk() {
        val now = "https://fever-solved-permissions-variations.trycloudflare.com"
        assertEquals(now, upgradeSavedUrl("https://deaths-fridge-portal-neck.trycloudflare.com", now))
        assertEquals(now, upgradeSavedUrl("", now))
        assertNull(upgradeSavedUrl(now, "$now/"))
        assertNull(upgradeSavedUrl("http://192.168.1.242:4721", now)) // a LAN / custom URL is his choice
        assertNull(upgradeSavedUrl("https://old.trycloudflare.com", "http://evil.example.com"))
        assertEquals(now, DeskBeacon.DEFAULT_PUBLIC_URL)
    }
}
