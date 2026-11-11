package com.dirk.nightdesk

import org.json.JSONObject

/**
 * The JSON a buy button posts. Paper buttons always name the paper book, even when
 * the desk mode is live. Live is a separate button and a separate body.
 */
object BuyRoute {
    /** The shared client. A paper fill is local and finishes inside this. */
    const val PAPER_BUY_TIMEOUT_SEC = 12
    /**
     * Live quote (8s) + swap build (8s) + confirmation budget (20s) is 36s.
     * The old 12s call gave up while the server could still be sending.
     */
    const val LIVE_BUY_TIMEOUT_SEC = 45

    fun liveTimeoutNotice(symbol: String): String =
        "$symbol: the desk did not answer in time. The swap may already be submitted. Do not tap again until you see a signature or a refusal that says nothing was sent."

    fun paperOneTap(mint: String, sizeUsd: Double, idemKey: String): JSONObject =
        JSONObject()
            .put("mint", mint)
            .put("sizeUsd", sizeUsd)
            .put("book", "paper")
            .put("idemKey", idemKey)
            .put("oneTap", true)

    fun liveOneTap(mint: String, sizeUsd: Double, idemKey: String): JSONObject =
        JSONObject()
            .put("mint", mint)
            .put("sizeUsd", sizeUsd)
            .put("book", "live")
            .put("idemKey", idemKey)
            .put("oneTap", true)

    /** v13.32 Buy anyway on a live tap. Still the live book. A new idemKey, so it is not a replay of the hold. */
    fun liveOverride(mint: String, sizeUsd: Double, idemKey: String): JSONObject =
        liveOneTap(mint, sizeUsd, idemKey)
            .put("confirmHardKill", true)
            .put("ignoreCooldown", true)

    fun paperDialog(
        mint: String,
        sizeUsd: Double?,
        ignoreCooldown: Boolean,
        confirmHardKill: Boolean,
        confirmSize: Boolean
    ): JSONObject {
        val body = JSONObject().put("mint", mint).put("book", "paper")
        if (sizeUsd != null && sizeUsd.isFinite()) body.put("sizeUsd", sizeUsd)
        if (ignoreCooldown) body.put("ignoreCooldown", true)
        if (confirmHardKill) body.put("confirmHardKill", true)
        if (confirmSize) body.put("confirmSize", true)
        return body
    }
}
