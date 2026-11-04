package com.dirk.nightdesk.portfolio

import com.dirk.nightdesk.wallet.SecureStore

/**
 * Extra read-only pubkeys for the desk portfolio, stored in [SecureStore].
 * The signer address from Mobile Wallet Adapter stays in [SecureStore.walletPubkey].
 */
object PortfolioWallets {
    const val KEY = "portfolio_pubkeys"

    fun decode(raw: String): List<String> = raw.split('\n').map { it.trim() }.filter { it.isNotEmpty() }

    fun encode(pubkeys: List<String>): String = pubkeys.distinct().joinToString("\n")

    fun read(store: SecureStore): List<String> {
        val saved = decode(store.get(KEY).orEmpty())
        val signer = store.walletPubkey()?.takeIf { it.isNotBlank() }
        return (listOfNotNull(signer) + saved).distinct()
    }

    fun add(store: SecureStore, pubkey: String): List<String> {
        val address = Pubkeys.require(pubkey)
        val next = (read(store) + address).distinct()
        store.put(KEY, encode(next))
        return next
    }
}
