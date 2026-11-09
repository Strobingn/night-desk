package com.dirk.nightdesk

/** Home shows a crash only for this install, and only until Dismiss. */
fun showDeskCrash(version: String, dismissed: Boolean, installed: String): Boolean {
    val recorded = version.trim()
    return !dismissed && recorded.isNotEmpty() && recorded == installed.trim()
}

/** First line of the on-phone crash file is `version 13.24`. */
fun phoneCrashVersion(text: String): String {
    val line = text.lineSequence().firstOrNull()?.trim() ?: return ""
    if (!line.startsWith("version ")) return ""
    return line.removePrefix("version ").trim()
}

fun showPhoneCrash(text: String?, hidden: Boolean, installed: String): Boolean {
    if (text.isNullOrBlank() || hidden) return false
    return showDeskCrash(phoneCrashVersion(text), false, installed)
}
