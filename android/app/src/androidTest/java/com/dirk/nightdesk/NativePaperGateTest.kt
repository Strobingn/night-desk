package com.dirk.nightdesk

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs on a device against the local armed desk at 10.0.2.2:8791.
 * The lightning button and Buy… must post book=paper. The live mock must not be
 * reached until the checklist is on, and a timed-out live tap keeps its idempotency key.
 */
@RunWith(AndroidJUnit4::class)
class NativePaperGateTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test(timeout = 360_000)
    fun paperButtonsFillPaperThenLiveTimesOutWithoutASecondSend() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        dismissBlockers(device)
        waitForDesk(device)
        openTab("Link")
        waitFor("Override URL")
        // The screen loads the saved link after the first frame and would wipe a URL typed too early.
        rule.waitForIdle()
        Thread.sleep(2_000)
        rule.onAllNodes(hasSetText())[0].performTextReplacement("http://10.0.2.2:8791")
        rule.waitForIdle()
        scrollUntil("Hold this URL instead of the beacon")
        rule.onNode(isToggleable()).performClick()
        rule.waitForIdle()
        scrollUntil("Save and hold this URL")
        tap("Save and hold this URL")
        waitFor("10.0.2.2:8791", 40_000)

        openTab("Tape")
        // The first connect waits out the blocked beacon before the local snapshot arrives.
        scrollUntil("GATE", 60_000)
        tapContains("⚡ Buy")
        waitFor("· paper")
        dismissNotice()
        tapContains("⚡ Sell")
        waitFor("Sold GATE")
        dismissNotice()

        tap("Buy…")
        waitFor("This Buy fills the paper book")
        tap("Buy")
        waitFor("· paper")
        dismissNotice()
        tapContains("⚡ Sell")
        waitFor("Sold GATE")
        dismissNotice()

        tap("LIVE BUY $5")
        waitFor("OPERATOR_NOT_READY")
        dismissNotice()

        openTab("Home")
        scrollUntil("Mark checklist ready")
        rule.onNode(isToggleable()).performClick()
        Thread.sleep(2_000)

        openTab("Tape")
        scrollUntil("LIVE BUY $5")
        tap("LIVE BUY $5")
        waitFor("did not answer in time", 55_000)
        dismissNotice()
        tap("LIVE BUY $5")
        Thread.sleep(4_000)
    }

    private fun dismissBlockers(device: UiDevice) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val deny = device.findObject(By.textContains("DON"))
            if (deny != null) {
                deny.click()
                Thread.sleep(400)
                continue
            }
            val pkg = device.currentPackageName ?: ""
            if (pkg.contains("settings") || pkg.contains("permissioncontroller")) {
                device.pressBack()
                Thread.sleep(400)
                continue
            }
            if (pkg == "com.dirk.nightdesk") return
            device.pressBack()
            device.wait(Until.hasObject(By.pkg("com.dirk.nightdesk")), 1_000)
        }
    }

    /** The battery prompt can cover the desk. Come back and wait until Compose has drawn. */
    private fun waitForDesk(device: UiDevice) {
        val deadline = System.currentTimeMillis() + 40_000
        while (System.currentTimeMillis() < deadline) {
            val drawn = runCatching {
                rule.onAllNodesWithText("Night", substring = true).fetchSemanticsNodes().isNotEmpty()
            }.getOrDefault(false)
            if (drawn) return
            val pkg = device.currentPackageName ?: ""
            if (pkg != "com.dirk.nightdesk") {
                device.pressBack()
                device.executeShellCommand("am start -n com.dirk.nightdesk/.MainActivity")
            }
            Thread.sleep(700)
        }
        error("Night Desk never drew. Last package ${device.currentPackageName}")
    }

    private fun openTab(label: String) {
        val matcher = hasText(label)
        repeat(5) {
            if (rule.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()) {
                rule.onNode(matcher).performTouchInput { click() }
                rule.waitForIdle()
                return
            }
            rule.onRoot().performTouchInput {
                swipe(Offset(right - 8f, bottom - 8f), Offset(8f, bottom - 8f), durationMillis = 200)
            }
            rule.waitForIdle()
        }
        error("Tab $label is not on screen")
    }

    private fun tap(text: String) {
        waitFor(text)
        rule.onNode(hasText(text)).performTouchInput { click() }
        rule.waitForIdle()
    }

    private fun tapContains(text: String) {
        waitFor(text)
        rule.onAllNodesWithText(text, substring = true)[0].performTouchInput { click() }
        rule.waitForIdle()
    }

    private fun scrollUntil(text: String, timeoutMs: Long = 20_000) {
        val matcher = hasText(text, substring = true)
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            if (runCatching { rule.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)) {
                runCatching { rule.onNode(matcher).performScrollTo() }
                rule.waitForIdle()
                return
            }
            runCatching {
                rule.onRoot().performTouchInput {
                    swipe(Offset(centerX, bottom * 0.72f), Offset(centerX, bottom * 0.32f), durationMillis = 150)
                }
            }
            // UiAutomator waits in real time. Compose waitUntil was holding the desk's beacon call.
            if (UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .wait(Until.hasObject(By.textContains(text)), 2_000)
            ) {
                runCatching { rule.onNode(matcher).performScrollTo() }
                return
            }
        }
        waitFor(text, 5_000)
    }

    private fun waitFor(text: String, timeoutMs: Long = 20_000) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        if (device.wait(Until.hasObject(By.textContains(text)), timeoutMs)) return
        val tree = runCatching { rule.onRoot(useUnmergedTree = true).printToString(maxDepth = 12) }.getOrElse { it.message ?: "" }
        throw AssertionError("Timed out waiting for \"$text\"\n${tree.take(2500)}")
    }

    private fun dismissNotice() {
        val nodes = rule.onAllNodesWithText("Dismiss").fetchSemanticsNodes()
        if (nodes.isNotEmpty()) {
            rule.onNode(hasText("Dismiss")).performClick()
            rule.waitForIdle()
        }
    }

    private fun hasSetText(): SemanticsMatcher =
        SemanticsMatcher("has set text") { it.config.contains(androidx.compose.ui.semantics.SemanticsActions.SetText) }
}
