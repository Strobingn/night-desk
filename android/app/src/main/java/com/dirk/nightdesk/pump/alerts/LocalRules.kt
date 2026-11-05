package com.dirk.nightdesk.pump.alerts

/**
 * On-device copy of the desk rules. Used when Firebase is not configured,
 * so alerts still fire with the app process alive.
 */
data class LocalRule(
    val id: String,
    val kind: String,
    val threshold: Double,
    val hysteresis: Double,
    val cooldownMs: Long,
    val delivery: String,
    val enabled: Boolean = true
)

data class LocalSample(
    val mint: String,
    val at: Long,
    val price: Double? = null,
    val marketCap: Double? = null,
    val progressPct: Double? = null,
    val holderCount: Double? = null,
    val graduated: Boolean? = null,
    val buyLamports: Double? = null,
    val buySignature: String? = null,
    val sellLamports: Double? = null,
    val sellSignature: String? = null
)

data class LocalFire(
    val id: String,
    val ruleId: String,
    val mint: String,
    val message: String,
    val delivery: String,
    val value: Double
)

class LocalAlertEngine(rules: List<LocalRule> = emptyList()) {
    private val rules = rules.toMutableList()
    private val high = HashMap<String, Boolean>()
    private val firedAt = HashMap<String, Long>()
    private val holders = HashMap<String, Double>()
    private val seen = HashMap<String, MutableSet<String>>()

    fun setRules(next: List<LocalRule>) {
        rules.clear()
        rules.addAll(next)
    }

    fun evaluate(sample: LocalSample): List<LocalFire> {
        val out = ArrayList<LocalFire>()
        for (rule in rules) {
            if (!rule.enabled) continue
            val hit = when (rule.kind) {
                "holders" -> holders(rule, sample)
                "graduation" -> graduation(rule, sample)
                "large_buy" -> event(rule, sample, sample.buyLamports, sample.buySignature)
                "whale_sell" -> event(rule, sample, sample.sellLamports, sample.sellSignature)
                else -> level(rule, sample, levelOf(rule, sample))
            }
            if (hit != null) out.add(hit)
        }
        return out
    }

    private fun level(rule: LocalRule, sample: LocalSample, value: Double?): LocalFire? {
        if (value == null) return null
        val key = "${rule.id}\n${sample.mint}"
        if (value >= rule.threshold) {
            if (high[key] == true) return null
            high[key] = true
            val previous = firedAt[key]
            if (previous != null && sample.at - previous < rule.cooldownMs) return null
            firedAt[key] = sample.at
            return fire(rule, sample, value)
        }
        if (value <= rule.threshold - kotlin.math.abs(rule.hysteresis)) high[key] = false
        return null
    }

    private fun holders(rule: LocalRule, sample: LocalSample): LocalFire? {
        val count = sample.holderCount ?: return null
        val key = "${rule.id}\n${sample.mint}"
        val prev = holders[key]
        holders[key] = count
        if (prev == null) return null
        val delta = count - prev
        if (delta >= rule.threshold) {
            if (high[key] == true) return null
            high[key] = true
            val previous = firedAt[key]
            if (previous != null && sample.at - previous < rule.cooldownMs) return null
            firedAt[key] = sample.at
            return fire(rule, sample, delta)
        }
        if (delta <= rule.threshold - kotlin.math.abs(rule.hysteresis)) high[key] = false
        return null
    }

    private fun graduation(rule: LocalRule, sample: LocalSample): LocalFire? {
        val graduated = sample.graduated ?: return null
        val key = "${rule.id}\n${sample.mint}"
        if (!graduated) {
            high[key] = false
            return null
        }
        if (high[key] == true) return null
        high[key] = true
        val previous = firedAt[key]
        if (previous != null && sample.at - previous < rule.cooldownMs) return null
        firedAt[key] = sample.at
        return fire(rule, sample, 1.0)
    }

    private fun event(rule: LocalRule, sample: LocalSample, size: Double?, signature: String?): LocalFire? {
        if (size == null || size < rule.threshold) return null
        val key = "${rule.id}\n${sample.mint}"
        val sig = signature ?: "${sample.mint}:${sample.at}"
        val bag = seen.getOrPut(key) { HashSet() }
        if (!bag.add(sig)) return null
        val previous = firedAt[key]
        if (previous != null && sample.at - previous < rule.cooldownMs) return null
        firedAt[key] = sample.at
        return fire(rule, sample, size)
    }

    private fun fire(rule: LocalRule, sample: LocalSample, value: Double) = LocalFire(
        id = "${rule.id}:${sample.mint}:${sample.at}",
        ruleId = rule.id,
        mint = sample.mint,
        message = "${rule.kind} ${sample.mint} crossed ${rule.threshold}",
        delivery = rule.delivery,
        value = value
    )

    private fun levelOf(rule: LocalRule, sample: LocalSample): Double? = when (rule.kind) {
        "price" -> sample.price
        "mcap" -> sample.marketCap
        "curve" -> sample.progressPct
        else -> null
    }
}
