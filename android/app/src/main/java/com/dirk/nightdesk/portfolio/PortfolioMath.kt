package com.dirk.nightdesk.portfolio

import java.math.BigInteger
import kotlin.math.min
import kotlin.math.round

/**
 * Same desk score as src/pump/portfolio/score.ts.
 *
 * score = round(100 * (0.5 * holdFactor + 0.5 * volumeFactor))
 * holdFactor = min(1, volumeWeightedHoldMs / 24h)
 * volumeFactor = min(1, tradedLamports / 10 SOL)
 *
 * Hold is the FIFO token-weighted time from buy to sell, or to now if still open.
 * Volume sums quote lamports on buys and sells and does not add fees.
 * A 24 hour weighted hold and 10 SOL of volume score 100. An empty book scores 0.
 */
object PortfolioMath {
    const val FORMULA =
        "score = round(100 * (0.5 * holdFactor + 0.5 * volumeFactor)). " +
            "holdFactor = min(1, volumeWeightedHoldMs / 24h), where hold is the FIFO token-weighted time from buy to sell, or from buy to now if the tokens are still open. " +
            "volumeFactor = min(1, tradedLamports / 10 SOL), where tradedLamports sums quote size on buys and sells and does not add fees. " +
            "The factors weigh equally. A 24 hour weighted hold and 10 SOL of volume score 100. An empty book scores 0."

    private val HOLD_TARGET = 86_400_000.0
    private val VOLUME_TARGET = BigInteger.valueOf(10_000_000_000L)
    const val UNKNOWN_BASIS =
        "No buy in the imported history covers this sell. Cost basis is unknown, so realized PnL is withheld."

    data class Fill(
        val signature: String,
        val wallet: String,
        val mint: String,
        val side: String,
        val solLamports: String,
        val tokenAmount: String,
        val feeLamports: String,
        val timestamp: Long
    )

    data class Position(
        val wallet: String,
        val mint: String,
        val tokenAmount: String,
        val realizedPnlLamports: String?,
        val realizedReason: String?,
        val avgEntryLamportsPerToken: String?
    )

    data class Score(val score: Int, val volumeLamports: String, val formula: String)

    fun score(fills: List<Fill>, now: Long): Score {
        val books = linkedMapOf<String, MutableList<Lot>>()
        var weighted = BigInteger.ZERO
        var weight = BigInteger.ZERO
        var volume = BigInteger.ZERO
        for (fill in fills.sortedWith(compareBy({ it.timestamp }, { it.signature }))) {
            volume += fill.solLamports.toBig()
            val lots = books.getOrPut("${fill.wallet}\u0000${fill.mint}") { mutableListOf() }
            if (fill.side == "buy") {
                lots += Lot(fill.tokenAmount.toBig(), fill.timestamp)
                continue
            }
            var need = fill.tokenAmount.toBig()
            while (need > BigInteger.ZERO && lots.isNotEmpty()) {
                val lot = lots[0]
                val take = if (need < lot.tokens) need else lot.tokens
                val held = (fill.timestamp - lot.ts).coerceAtLeast(0)
                weighted += BigInteger.valueOf(held) * take
                weight += take
                lot.tokens -= take
                need -= take
                if (lot.tokens == BigInteger.ZERO) lots.removeAt(0)
            }
        }
        for (lots in books.values) {
            for (lot in lots) {
                if (lot.tokens <= BigInteger.ZERO) continue
                val held = (now - lot.ts).coerceAtLeast(0)
                weighted += BigInteger.valueOf(held) * lot.tokens
                weight += lot.tokens
            }
        }
        val holdMs = if (weight == BigInteger.ZERO) 0.0 else weighted.divide(weight).toDouble()
        val holdFactor = min(1.0, holdMs / HOLD_TARGET)
        val volumeFactor = min(1.0, volume.toDouble() / VOLUME_TARGET.toDouble())
        return Score(round(100.0 * (0.5 * holdFactor + 0.5 * volumeFactor)).toInt(), volume.toString(), FORMULA)
    }

    fun positions(fills: List<Fill>): List<Position> {
        val groups = linkedMapOf<String, MutableList<Fill>>()
        for (fill in fills.sortedWith(compareBy({ it.timestamp }, { it.signature }))) {
            groups.getOrPut("${fill.wallet}\u0000${fill.mint}") { mutableListOf() }.add(fill)
        }
        return groups.values.map { settle(it) }
    }

    fun aggregateRealized(positions: List<Position>): String? {
        if (positions.any { it.realizedPnlLamports == null }) return null
        return positions.fold(BigInteger.ZERO) { acc, position -> acc + (position.realizedPnlLamports ?: "0").toBig() }.toString()
    }

    private fun settle(fills: List<Fill>): Position {
        val lots = mutableListOf<Lot>()
        val costs = mutableListOf<BigInteger>()
        var tokens = BigInteger.ZERO
        var cost = BigInteger.ZERO
        var realized = BigInteger.ZERO
        var unknown = false
        for (fill in fills) {
            val size = fill.tokenAmount.toBig()
            if (fill.side == "buy") {
                val lotCost = fill.solLamports.toBig() + fill.feeLamports.toBig()
                lots += Lot(size, fill.timestamp)
                costs += lotCost
                tokens += size
                cost += lotCost
                continue
            }
            var need = size
            var soldCost = BigInteger.ZERO
            var i = 0
            while (need > BigInteger.ZERO && i < lots.size) {
                val lot = lots[i]
                val take = if (need < lot.tokens) need else lot.tokens
                val takeCost = costs[i] * take / lot.tokens
                costs[i] = costs[i] - takeCost
                lot.tokens -= take
                need -= take
                soldCost += takeCost
                if (lot.tokens == BigInteger.ZERO) {
                    lots.removeAt(i)
                    costs.removeAt(i)
                } else {
                    i += 1
                }
            }
            tokens -= size
            if (need > BigInteger.ZERO) {
                unknown = true
            } else {
                val pnl = fill.solLamports.toBig() - fill.feeLamports.toBig() - soldCost
                realized += pnl
                cost -= soldCost
            }
        }
        val first = fills.first()
        if (unknown) {
            return Position(first.wallet, first.mint, tokens.toString(), null, UNKNOWN_BASIS, null)
        }
        val avg = if (tokens > BigInteger.ZERO) cost.divide(tokens).toString() else null
        return Position(first.wallet, first.mint, tokens.toString(), realized.toString(), null, avg)
    }

    private class Lot(var tokens: BigInteger, val ts: Long)

    private fun String.toBig(): BigInteger = BigInteger(this)
}

/** Base58 public keys only. A 64-byte secret does not pass. */
object Pubkeys {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun require(value: String): String {
        val bytes = decode(value.trim())
        if (bytes.size != 32) throw IllegalArgumentException("Wallet must be a 32-byte public key. Night Desk stores the address only.")
        return value.trim()
    }

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""
        val copy = input.copyOf()
        var zeros = 0
        while (zeros < copy.size && copy[zeros] == 0.toByte()) zeros++
        val encoded = StringBuilder()
        var start = zeros
        while (start < copy.size) {
            var remainder = 0
            for (i in start until copy.size) {
                val acc = remainder * 256 + (copy[i].toInt() and 0xff)
                copy[i] = (acc / 58).toByte()
                remainder = acc % 58
            }
            encoded.append(ALPHABET[remainder])
            while (start < copy.size && copy[start] == 0.toByte()) start++
        }
        repeat(zeros) { encoded.append('1') }
        return encoded.reverse().toString()
    }

    fun decode(input: String): ByteArray {
        if (input.isEmpty()) return ByteArray(0)
        var zeros = 0
        while (zeros < input.length && input[zeros] == '1') zeros++
        val b256 = ByteArray(input.length)
        for (ch in input) {
            val digit = ALPHABET.indexOf(ch)
            if (digit < 0) throw IllegalArgumentException("Wallet must be a Solana public key.")
            var carry = digit
            for (j in b256.indices.reversed()) {
                carry += 58 * (b256[j].toInt() and 0xff)
                b256[j] = (carry % 256).toByte()
                carry /= 256
            }
        }
        var strip = 0
        while (strip < b256.size && b256[strip] == 0.toByte()) strip++
        return ByteArray(zeros) + b256.copyOfRange(strip, b256.size)
    }
}
