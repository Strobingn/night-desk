package com.dirk.nightdesk.pump

import java.math.BigInteger

/**
 * Same integer curve formulas as the server reverse quote.
 * A target-mcap pre-fill uses this so the SOL amount matches the core quote.
 */
object CurveMath {
    val LAMPORTS: BigInteger = BigInteger.valueOf(1_000_000_000L)

    data class Reserves(
        val virtualTokenReserves: BigInteger,
        val virtualQuoteReserves: BigInteger,
        val realTokenReserves: BigInteger,
        val realQuoteReserves: BigInteger,
        val tokenTotalSupply: BigInteger,
        val complete: Boolean = false
    )

    data class ReverseQuote(
        val targetMarketCapLamports: BigInteger,
        val solNeededLamports: BigInteger,
        val reachable: Boolean,
        val marketCapLamports: BigInteger
    )

    fun canonical(): Reserves = Reserves(
        virtualTokenReserves = BigInteger("1073000000000000"),
        virtualQuoteReserves = BigInteger("30000000000"),
        realTokenReserves = BigInteger("793100000000000"),
        realQuoteReserves = BigInteger.ZERO,
        tokenTotalSupply = BigInteger("1000000000000000"),
        complete = false
    )

    fun marketCap(reserves: Reserves): BigInteger {
        if (reserves.virtualTokenReserves.signum() <= 0) error("virtual token reserves are zero")
        return reserves.virtualQuoteReserves.multiply(reserves.tokenTotalSupply).divide(reserves.virtualTokenReserves)
    }

    fun solInForTokens(reserves: Reserves, tokens: BigInteger): BigInteger {
        if (tokens.signum() <= 0) return BigInteger.ZERO
        val left = reserves.virtualTokenReserves.subtract(tokens)
        if (left.signum() <= 0) error("tokens exhaust the virtual reserves")
        return tokens.multiply(reserves.virtualQuoteReserves).divide(left).add(BigInteger.ONE)
    }

    fun tokensForCurveSol(reserves: Reserves, solIn: BigInteger): BigInteger {
        if (solIn.signum() <= 0) return BigInteger.ZERO
        val out = solIn.multiply(reserves.virtualTokenReserves).divide(reserves.virtualQuoteReserves.add(solIn))
        return if (out < reserves.realTokenReserves) out else reserves.realTokenReserves
    }

    fun solRemaining(reserves: Reserves): BigInteger {
        if (reserves.complete || reserves.realTokenReserves.signum() <= 0) return BigInteger.ZERO
        return solInForTokens(reserves, reserves.realTokenReserves)
    }

    fun graduationMarketCap(reserves: Reserves): BigInteger {
        if (reserves.realTokenReserves.signum() <= 0) return marketCap(reserves)
        val endToken = reserves.virtualTokenReserves.subtract(reserves.realTokenReserves)
        if (endToken.signum() <= 0) error("real token reserves pass the virtual reserves")
        val added = reserves.realTokenReserves.multiply(reserves.virtualQuoteReserves).divide(endToken)
        return reserves.virtualQuoteReserves.add(added).multiply(reserves.tokenTotalSupply).divide(endToken)
    }

    fun progressPct(reserves: Reserves): Double? {
        if (reserves.virtualTokenReserves.signum() <= 0) return null
        if (reserves.realTokenReserves > reserves.virtualTokenReserves) return null
        if (reserves.complete || reserves.realTokenReserves.signum() <= 0) return 100.0
        val canonical = canonical()
        val offset = reserves.virtualTokenReserves.subtract(reserves.realTokenReserves)
        val canonicalOffset = canonical.virtualTokenReserves.subtract(canonical.realTokenReserves)
        if (offset == canonicalOffset && reserves.realTokenReserves <= canonical.realTokenReserves) {
            val sold = canonical.realTokenReserves.subtract(reserves.realTokenReserves)
            return sold.multiply(BigInteger.valueOf(10_000)).divide(canonical.realTokenReserves).toDouble() / 100.0
        }
        val inn = reserves.realQuoteReserves
        if (inn < BigInteger.valueOf(10_000_000L)) return null
        val left = solRemaining(reserves)
        val denom = inn.add(left)
        if (denom.signum() <= 0) return null
        return inn.multiply(BigInteger.valueOf(10_000)).divide(denom).toDouble() / 100.0
    }

    fun solToReachMarketCap(reserves: Reserves, targetLamports: BigInteger): ReverseQuote {
        val current = marketCap(reserves)
        if (targetLamports <= current) {
            return ReverseQuote(targetLamports, BigInteger.ZERO, true, current)
        }
        val grad = graduationMarketCap(reserves)
        val remaining = solRemaining(reserves)
        if (targetLamports > grad) {
            return ReverseQuote(targetLamports, remaining, false, grad)
        }
        var lo = BigInteger.ZERO
        var hi = if (remaining.signum() > 0) remaining else targetLamports
        while (lo < hi) {
            val mid = lo.add(hi).shiftRight(1)
            if (mcapAfterBuy(reserves, mid) >= targetLamports) hi = mid else lo = mid.add(BigInteger.ONE)
        }
        return ReverseQuote(targetLamports, lo, true, mcapAfterBuy(reserves, lo))
    }

    fun formatSol(lamports: BigInteger): String {
        val neg = lamports.signum() < 0
        val v = lamports.abs()
        val whole = v.divide(LAMPORTS)
        val frac = v.remainder(LAMPORTS).toString().padStart(9, '0').trimEnd('0')
        val text = if (frac.isEmpty()) whole.toString() else "$whole.$frac"
        return if (neg) "-$text" else text
    }

    private fun mcapAfterBuy(reserves: Reserves, solIn: BigInteger): BigInteger {
        if (solIn.signum() <= 0) return marketCap(reserves)
        val tokens = tokensForCurveSol(reserves, solIn)
        val nextToken = reserves.virtualTokenReserves.subtract(tokens)
        if (nextToken.signum() <= 0) return graduationMarketCap(reserves)
        val nextQuote = reserves.virtualQuoteReserves.add(solIn)
        return nextQuote.multiply(reserves.tokenTotalSupply).divide(nextToken)
    }
}
