package com.dirk.nightdesk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashCardTest {
    @Test
    fun homeCardMatchesInstalledVersionAndDismissal() {
        assertFalse(showDeskCrash("13.18", false, "13.24"))
        assertTrue(showDeskCrash("13.24", false, "13.24"))
        assertFalse(showDeskCrash("13.24", true, "13.24"))
        assertFalse(showDeskCrash("", false, "13.24"))
        assertFalse(showDeskCrash("13.24", false, "13.18"))
    }

    @Test
    fun phoneFileUsesItsVersionLineAndAHiddenFlag() {
        val old = "version 13.18\nthread main\nandroid.os.NetworkOnMainThreadException\n"
        val current = "version 13.24\nthread main\njava.lang.IllegalStateException\n"
        assertFalse(showPhoneCrash(old, false, "13.24"))
        assertTrue(showPhoneCrash(current, false, "13.24"))
        assertFalse(showPhoneCrash(current, true, "13.24"))
        assertEqualsVersion("13.18", phoneCrashVersion(old))
    }

    private fun assertEqualsVersion(expected: String, actual: String) {
        org.junit.Assert.assertEquals(expected, actual)
    }
}
