package com.dirk.nightdesk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** One-tap Buy from a near-miss notification. Size is omitted so the desk uses the cap. */
class DeskBuyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val mint = intent.getStringExtra(EXTRA_MINT)?.takeIf { it.isNotBlank() } ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                DeskRepository.get(context).buyPosition(mint, null)
            } catch (error: Throwable) {
                CrashLog.write(context, Thread.currentThread(), error)
            } finally {
                runCatching { pending.finish() }
            }
        }
    }

    companion object {
        const val EXTRA_MINT = "mint"
    }
}
