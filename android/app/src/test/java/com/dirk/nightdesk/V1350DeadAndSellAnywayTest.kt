package com.dirk.nightdesk

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class V1350DeadAndSellAnywayTest {
    @Test
    fun homeMovesDeadCoinsIntoACollapsedSection() {
        val home = read("src/main/java/com/dirk/nightdesk/ui/NightDeskApp.kt")
        val web = readWeb("src/screens/Home.tsx")
        assertTrue(home.contains("Dead / no sell route"))
        assertTrue(home.contains("isDeadHolding"))
        assertTrue(home.contains("collapsible = true, open = false"))
        assertTrue(web.contains("Dead / no sell route"))
        assertTrue(web.contains("splitHoldings"))
        assertFalse(home.contains("positions.remove"))
    }

    @Test
    fun sellAnywayIsAConfirmAndADrainedPoolIsNot() {
        val repo = read("src/main/java/com/dirk/nightdesk/DeskRepository.kt")
        val home = read("src/main/java/com/dirk/nightdesk/ui/NightDeskApp.kt")
        val web = readWeb("src/App.tsx")
        assertTrue(repo.contains("sellAnyway"))
        assertTrue(home.contains("Sell anyway"))
        assertTrue(web.contains("Sell anyway"))
        assertTrue(web.contains("allowSellAnyway"))
        val over = JSONObject("""{"ok":false,"code":"EXIT_IMPACT","allowSellAnyway":true,"error":"A full exit would cost 22.00%, more than your 6.00% exit slippage setting. Sell refused."}""")
        assertTrue(OneTap.offersSellAnyway(over))
        val drained = JSONObject("""{"ok":false,"code":"NO_SELL_ROUTE","error":"No sell route, pool drained. Nothing was sent."}""")
        assertFalse(OneTap.offersSellAnyway(drained))
        assertTrue(OneTap.sellText("DACITY", drained, false, 0).contains("No sell route, pool drained"))
    }

    private fun read(path: String): String {
        val file = listOf(File(path), File("app/$path"), File("android/app/$path")).firstOrNull { it.isFile }
            ?: error("missing $path from ${File(".").absolutePath}")
        return file.readText()
    }

    private fun readWeb(path: String): String {
        val file = listOf(File("web/$path"), File("../web/$path"), File("../../web/$path")).firstOrNull { it.isFile }
            ?: error("missing web/$path from ${File(".").absolutePath}")
        return file.readText()
    }
}
