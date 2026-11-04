package com.dirk.nightdesk.wallet

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Wallet pubkeys and terminal settings, encrypted with AES-GCM.
 * The key lives in AndroidKeyStore. Values in preferences are ciphertext.
 */
@OptIn(ExperimentalEncodingApi::class)
class SecureStore(private val prefs: SharedPreferences, private val key: SecretKey) {
    fun saveWalletPubkey(pubkey: String) = put(WALLET, pubkey)
    fun walletPubkey(): String? = get(WALLET)
    fun saveSettings(json: String) = put(SETTINGS, json)
    fun settings(): String? = get(SETTINGS)

    fun put(name: String, value: String) {
        val blob = encrypt(key, value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(name, Base64.encode(blob)).apply()
    }

    fun get(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            String(decrypt(key, Base64.decode(stored)), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val WALLET = "wallet_pubkey"
        const val SETTINGS = "terminal_settings"
        private const val ALIAS = "nightdesk.pump.wallet"
        private const val PREFS = "night_desk_pump_secure"

        fun open(context: Context): SecureStore {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return SecureStore(prefs, keystoreKey())
        }

        fun forTest(prefs: SharedPreferences, key: SecretKey) = SecureStore(prefs, key)

        private fun keystoreKey(): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = store.getKey(ALIAS, null)
            if (existing is SecretKey) return existing
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            return generator.generateKey()
        }

        fun encrypt(key: SecretKey, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val body = cipher.doFinal(plain)
            return byteArrayOf(iv.size.toByte()) + iv + body
        }

        fun decrypt(key: SecretKey, blob: ByteArray): ByteArray {
            if (blob.isEmpty()) error("empty ciphertext")
            val ivLen = blob[0].toInt() and 0xff
            if (ivLen <= 0 || 1 + ivLen >= blob.size) error("bad ciphertext")
            val iv = blob.copyOfRange(1, 1 + ivLen)
            val body = blob.copyOfRange(1 + ivLen, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            return cipher.doFinal(body)
        }
    }
}
