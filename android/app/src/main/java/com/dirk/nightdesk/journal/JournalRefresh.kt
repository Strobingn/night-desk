package com.dirk.nightdesk.journal

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue

/**
 * Mounted journal, replay, and portfolio panels all stay on screen together.
 * Import writes the server book; bumping this tick is what makes those panels fetch again.
 */
object JournalRefresh {
    var tick by mutableIntStateOf(0)
        private set

    fun bump() {
        tick += 1
    }
}
