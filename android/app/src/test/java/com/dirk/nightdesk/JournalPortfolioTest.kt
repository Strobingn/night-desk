package com.dirk.nightdesk

import android.content.Intent
import android.net.Uri
import com.dirk.nightdesk.journal.JournalFill
import com.dirk.nightdesk.journal.JournalFormat
import com.dirk.nightdesk.journal.ReportImage
import com.dirk.nightdesk.portfolio.PortfolioMath
import com.dirk.nightdesk.portfolio.PortfolioWallets
import com.dirk.nightdesk.portfolio.Pubkeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Journal CSV offsets, fixture PnL, desk score, and the share-sheet intent. */
class JournalPortfolioTest {
    private val walletA = "So11111111111111111111111111111111111111112"
    private val walletB = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    private val mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    private val mintB = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

    @Test fun easternOffsetsFollowDaylightSaving() {
        assertEquals("2026-07-15T14:00:00.000-04:00", JournalFormat.formatEt(java.time.Instant.parse("2026-07-15T18:00:00.000Z").toEpochMilli()))
        assertEquals("2026-01-15T13:00:00.000-05:00", JournalFormat.formatEt(java.time.Instant.parse("2026-01-15T18:00:00.000Z").toEpochMilli()))
        assertEquals("2026-03-08T01:30:00.000-05:00", JournalFormat.formatEt(java.time.Instant.parse("2026-03-08T06:30:00.000Z").toEpochMilli()))
        assertEquals("2026-11-01T01:30:00.000-05:00", JournalFormat.formatEt(java.time.Instant.parse("2026-11-01T06:30:00.000Z").toEpochMilli()))
    }

    @Test fun fixtureWalletsAggregateAndUnknownBasisIsNotZero() {
        val fills = listOf(
            PortfolioMath.Fill("deskABuy", walletA, mintA, "buy", "1000000000", "1000000", "10000000", 1700000000000),
            PortfolioMath.Fill("deskASell", walletA, mintA, "sell", "800000000", "400000", "5000000", 1700021600000),
            PortfolioMath.Fill("deskBBuy", walletB, mintB, "buy", "50000000", "100", "0", 1700003600000),
            PortfolioMath.Fill("deskBSell", walletB, mintB, "sell", "80000000", "100", "1000000", 1700007200000)
        )
        val positions = PortfolioMath.positions(fills)
        assertEquals(2, positions.size)
        assertEquals("420000000", PortfolioMath.aggregateRealized(positions))
        assertEquals("1010", positions.first { it.mint == mintA }.avgEntryLamportsPerToken)
        assertEquals("600000", positions.first { it.mint == mintA }.tokenAmount)
        val score = PortfolioMath.score(fills, 1700043200000)
        assertEquals(30, score.score)
        assertTrue(score.formula.contains("holdFactor"))
        val unknown = PortfolioMath.positions(
            listOf(PortfolioMath.Fill("orphan", "11111111111111111111111111111111", mintA, "sell", "1000", "10", "0", 1))
        )
        assertNull(unknown[0].realizedPnlLamports)
        assertTrue(unknown[0].realizedReason!!.contains("unknown", ignoreCase = true))
        assertNull(PortfolioMath.aggregateRealized(unknown))
    }

    @Test fun pubkeysAre32BytesAndSecretsAreRefused() {
        assertEquals(32, Pubkeys.decode(walletA).size)
        assertEquals(walletA, Pubkeys.require(walletA))
        assertEquals("1".repeat(32), Pubkeys.encode(ByteArray(32)))
        assertEquals(listOf(walletA), PortfolioWallets.decode(walletA))
        try {
            Pubkeys.require("1".repeat(64))
            throw AssertionError("a 64-byte key should not be stored")
        } catch (err: IllegalArgumentException) {
            assertTrue(err.message!!.contains("32-byte"))
        }
    }

    @Test fun reportShareSheetSendsThePng() {
        val intent = ReportImage.shareIntent(Uri.parse("content://com.dirk.nightdesk.deskreport/desk_reports/desk-report.png"))
        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("image/png", intent.type)
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val xml = filePaths()
        assertTrue(xml.contains("cache-path"))
        assertTrue(xml.contains("desk-reports"))
        val csv = JournalFormat.csv(
            listOf(
                JournalFill(
                    signature = "s",
                    wallet = walletA,
                    mint = mintA,
                    side = "sell",
                    venue = "curve",
                    solLamports = "1",
                    tokenAmount = "1",
                    feeLamports = "0",
                    marketCapLamports = "2",
                    priceLamportsPerToken = "1",
                    timestamp = java.time.Instant.parse("2026-07-15T18:00:00.000Z").toEpochMilli(),
                    outcome = "unknown_basis",
                    realizedPnlLamports = null,
                    costBasisReason = "Cost basis is unknown"
                )
            )
        )
        assertTrue(csv.contains("2026-07-15T14:00:00.000-04:00"))
        assertTrue(!csv.contains(",0,unknown_basis"))
    }

    private fun filePaths(): String {
        val candidates = listOf(File("src/main/res/xml/file_paths.xml"), File("android/app/src/main/res/xml/file_paths.xml"))
        return candidates.first { it.isFile }.readText()
    }
}
