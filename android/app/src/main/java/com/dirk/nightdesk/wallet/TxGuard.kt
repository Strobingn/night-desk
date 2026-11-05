package com.dirk.nightdesk.wallet

import java.math.BigInteger

/**
 * Checks an unsigned legacy transaction before the Mobile Wallet Adapter opens.
 * Fee payer must be the connected wallet, every program must be allowlisted,
 * and the trade amount (and any system transfer from the fee payer) must sit at or under the cap.
 */
class TxGuard {
    data class Verdict(val ok: Boolean, val code: String? = null, val message: String? = null)

    fun inspect(unsignedTx: String, wallet: String, amountLamports: BigInteger, capLamports: BigInteger): Verdict {
        if (capLamports.signum() < 0 || amountLamports.signum() < 0) {
            return Verdict(false, "MALFORMED", "Amount and cap must be non-negative lamports.")
        }
        if (amountLamports > capLamports) return Verdict(false, "OVER_CAP", "Trade amount is above the cap.")
        val decoded = try {
            decodeLegacy(bytesFromBase64(unsignedTx))
        } catch (err: IllegalArgumentException) {
            return Verdict(false, "MALFORMED", err.message ?: "Transaction could not be read.")
        }
        if (decoded.feePayer != wallet) return Verdict(false, "FOREIGN_FEE_PAYER", "Fee payer is not the connected wallet.")
        for (program in decoded.programIds) {
            if (program !in ALLOWED) return Verdict(false, "UNKNOWN_PROGRAM", "Program $program is not allowlisted.")
        }
        if (decoded.feePayerSystemSpend > capLamports) {
            return Verdict(false, "OVER_CAP", "System-program spend by the fee payer is above the cap.")
        }
        return Verdict(true)
    }

    private data class Decoded(val feePayer: String, val programIds: List<String>, val feePayerSystemSpend: BigInteger)

    private class Reader(private val bytes: ByteArray) {
        private var pos = 0
        fun remaining() = bytes.size - pos
        fun u8(): Int {
            if (pos >= bytes.size) error("Transaction ended early.")
            return bytes[pos++].toInt() and 0xff
        }
        fun bytesOf(n: Int): ByteArray {
            if (n < 0 || pos + n > bytes.size) error("Transaction ended early.")
            return bytes.copyOfRange(pos, pos + n).also { pos += n }
        }
        fun compactU16(): Int {
            var value = 0
            var shift = 0
            repeat(3) {
                val b = u8()
                value = value or ((b and 0x7f) shl shift)
                if (b and 0x80 == 0) return value
                shift += 7
            }
            error("Compact length is too wide.")
        }
    }

    private fun decodeLegacy(bytes: ByteArray): Decoded {
        val r = Reader(bytes)
        val sigs = r.compactU16()
        if (sigs > 8) error("Too many signatures.")
        r.bytesOf(sigs * 64)
        val lead = r.u8()
        if (lead and 0x80 != 0) error("Versioned transactions are not accepted.")
        r.u8(); r.u8()
        val keyCount = r.compactU16()
        if (keyCount < 1 || keyCount > 64) error("Account list is empty or too long.")
        val keys = ArrayList<String>(keyCount)
        repeat(keyCount) { keys += encodeBase58(r.bytesOf(32)) }
        r.bytesOf(32)
        val ixCount = r.compactU16()
        val programs = ArrayList<String>(ixCount)
        var spend = BigInteger.ZERO
        val feePayer = keys[0]
        repeat(ixCount) {
            val program = keys.getOrNull(r.u8()) ?: error("Instruction program index is out of range.")
            programs += program
            val accounts = IntArray(r.compactU16()) { r.u8() }
            val data = r.bytesOf(r.compactU16())
            if (program == SYSTEM && data.size >= 12 && u32le(data) == 2) {
                val source = accounts.getOrNull(0)?.let { keys.getOrNull(it) }
                if (source == feePayer) spend += u64le(data, 4)
            }
        }
        if (r.remaining() != 0) error("Transaction has trailing bytes.")
        return Decoded(feePayer, programs, spend)
    }

    companion object {
        const val SYSTEM = "11111111111111111111111111111111"
        val ALLOWED: Set<String> = setOf(
            "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
            "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
            "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
            SYSTEM,
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
            "ComputeBudget111111111111111111111111111111"
        )
        private const val BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        fun encodeBase58(bytes: ByteArray): String {
            var zeros = 0
            while (zeros < bytes.size && bytes[zeros].toInt() == 0) zeros += 1
            var n = BigInteger.ZERO
            for (b in bytes) n = n.shiftLeft(8).add(BigInteger.valueOf((b.toInt() and 0xff).toLong()))
            val body = StringBuilder()
            val fiftyEight = BigInteger.valueOf(58)
            while (n.signum() > 0) {
                val div = n.divideAndRemainder(fiftyEight)
                n = div[0]
                body.insert(0, BASE58[div[1].toInt()])
            }
            return "1".repeat(zeros) + body
        }

        fun bytesFromBase64(b64: String): ByteArray {
            val clean = b64.replace(Regex("\\s"), "")
            if (clean.isEmpty() || clean.length % 4 != 0 || !clean.matches(Regex("^[A-Za-z0-9+/]+={0,2}$"))) {
                error("Transaction is not base64.")
            }
            val pad = when {
                clean.endsWith("==") -> 2
                clean.endsWith("=") -> 1
                else -> 0
            }
            val out = ByteArray((clean.length / 4) * 3 - pad)
            var p = 0
            var i = 0
            while (i < clean.length) {
                val a = B64.indexOf(clean[i])
                val b = B64.indexOf(clean[i + 1])
                val c = if (clean[i + 2] == '=') 0 else B64.indexOf(clean[i + 2])
                val d = if (clean[i + 3] == '=') 0 else B64.indexOf(clean[i + 3])
                if (a < 0 || b < 0 || c < 0 || d < 0) error("Transaction is not base64.")
                val n = (a shl 18) or (b shl 12) or (c shl 6) or d
                if (p < out.size) out[p++] = ((n shr 16) and 255).toByte()
                if (p < out.size) out[p++] = ((n shr 8) and 255).toByte()
                if (p < out.size) out[p++] = (n and 255).toByte()
                i += 4
            }
            return out
        }

        private fun u32le(data: ByteArray): Int {
            return (data[0].toInt() and 0xff) or
                ((data[1].toInt() and 0xff) shl 8) or
                ((data[2].toInt() and 0xff) shl 16) or
                ((data[3].toInt() and 0xff) shl 24)
        }

        private fun u64le(data: ByteArray, offset: Int): BigInteger {
            var n = BigInteger.ZERO
            for (i in 0 until 8) {
                val b = BigInteger.valueOf((data[offset + i].toInt() and 0xff).toLong())
                n = n.add(b.shiftLeft(8 * i))
            }
            return n
        }
    }
}

private fun error(message: String): Nothing = throw IllegalArgumentException(message)
