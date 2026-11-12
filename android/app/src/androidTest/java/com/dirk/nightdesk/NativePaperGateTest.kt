package com.dirk.nightdesk

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.isRoot
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
        // v13.32 Link lives under Settings → More.
        openTab("Settings")
        waitFor("Link")
        tap("Link")
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
        scrollUntil("FRESH", 60_000)
        waitFor("not enriched")
        shot("tape")
        scrollUntil("GATE", 60_000)
        // FRESH is also a Tape card. The buy has to be the one on GATE.
        tapBelow("GATE", "⚡ Buy", substring = true)
        waitFor("· paper")
        dismissNotice()
        openTab("Home")
        shot("home-top")
        // v13.32 the Home list is a tagged LazyColumn: scroll it to each card by node, not by swiping.
        for (symbol in listOf("DRC", "SPCX", "NOVA", "GATE")) homeScrollTo(hasTestTag("details-$symbol"))
        shot("home-collapsed")
        openDetails("GATE")
        homeScrollTo(hasText("Sell 25%"))
        homeScrollTo(hasText("Sell 100%"))
        shot("home-expanded")
        openTab("Settings")
        scrollUntil("One tap")
        scrollUntil("Slip")
        shot("settings-onetap")
        openTab("Engine")
        waitFor("SCORECARD")
        shot("engine")
        openTab("Tape")
        scrollUntil("⚡ Sell")
        tapContains("⚡ Sell")
        waitFor("Sold GATE")
        dismissNotice()

        // FRESH stays on the tape with its own Buy…. The dialog has to open from GATE.
        scrollUntil("GATE")
        tapBelow("GATE", "Buy…")
        waitFor("This Buy fills the paper book")
        tapRightmost("Buy")
        waitFor("(paper)")
        dismissNotice()
        tapContains("⚡ Sell")
        waitFor("Sold GATE")
        dismissNotice()

        openTab("Search")
        waitFor("Look up")
        rule.onAllNodes(hasSetText())[0].performTextReplacement("SEEK")
        tap("Look up")
        waitFor("2HNb")
        closeIme()
        // The hard-kill sentence also contains "anyway". Only the button opens the confirm.
        val hardButton = hasText("anyway…", substring = true) and hasClickAction()
        val paperButton = hasText("Paper buy", substring = true) and hasClickAction()
        val hardKill = rule.onAllNodes(hardButton).fetchSemanticsNodes().isNotEmpty()
        val action = if (hardKill) hardButton else paperButton
        dismissAnr()
        scrollClickable(action)
        dismissAnr()
        shot("search")
        rule.onNode(action).performClick()
        rule.waitForIdle()
        if (hardKill) {
            // The confirm dialog is its own Compose root. onRoot() throws once it is open.
            val confirm = hasText("Buy anyway") and hasClickAction()
            val deadline = System.currentTimeMillis() + 10_000
            while (rule.onAllNodes(confirm).fetchSemanticsNodes().isEmpty()) {
                if (System.currentTimeMillis() > deadline) error("Paper confirm did not open")
                dismissAnr()
                Thread.sleep(200)
            }
            dismissAnr()
            rule.onNode(confirm).performClick()
        } else {
            tapRightmost("Buy")
        }
        waitFor("(paper)")
        dismissNotice()
        openTab("Home")
        scrollUntil("SEEK")
        openDetails("SEEK")
        tapContains("⚡ Sell")
        waitFor("Sold SEEK")
        dismissNotice()

        openTab("Tape")
        // SEEK is on the tape too, so both cards show LIVE BUY $5. The live checks stay on GATE.
        // v13.32 the LIVE strip is folded on each card; open it on GATE first.
        openLive("GATE")
        tapBelow("GATE", "LIVE BUY $5")
        waitFor("OPERATOR_NOT_READY")
        dismissNotice()

        openTab("Home")
        // v13.32 the checklist sits in the folded "Wallet & live" section.
        homeScrollTo(hasText("Wallet & live"))
        tapContains("Wallet & live")
        homeScrollTo(hasText("Mark checklist ready"))
        rule.onNode(isToggleable()).performClick()
        Thread.sleep(2_000)

        openTab("Tape")
        openLive("GATE")
        tapBelow("GATE", "LIVE BUY $5")
        waitFor("did not answer in time", 55_000)
        dismissNotice()
        openLive("GATE")
        tapBelow("GATE", "LIVE BUY $5")
        Thread.sleep(4_000)

        // v13.32 Pump lives under Settings → More.
        openTab("Settings")
        waitFor("Pump terminal")
        tap("Pump terminal")
        // The intro says "tap Watch". Scroll to the button itself so the mint field is on screen.
        rule.onNode(hasTestTag("pump-watch")).performScrollTo()
        rule.waitForIdle()
        rule.onNode(hasTestTag("pump-mint")).performTextReplacement("2HNbRAN6m3bhgYb9mCzH6ULoT8qQuTWE3pM1CyM1pump")
        closeIme()
        rule.onNode(hasTestTag("pump-watch")).performScrollTo().performClick()
        waitFor("Watching 2HNb", 25_000)
        shot("pump-watch")
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

    /** v13.32 the Details toggle on one position card, found by tag so another coin's card is never opened. */
    private fun openDetails(symbol: String) {
        homeScrollTo(hasTestTag("details-$symbol"))
        rule.onNode(hasTestTag("details-$symbol")).performClick()
        rule.waitForIdle()
    }

    /** Scrolls the Home list until a node matches. Works for items the lazy list has not composed yet. */
    private fun homeScrollTo(matcher: SemanticsMatcher) {
        val deadline = System.currentTimeMillis() + 20_000
        while (true) {
            val ok = runCatching { rule.onNode(hasTestTag("home-list")).performScrollToNode(matcher) }.isSuccess
            rule.waitForIdle()
            if (ok || System.currentTimeMillis() > deadline) break
            dismissAnr()
            Thread.sleep(300)
        }
        rule.onNode(matcher).assertExists()
    }

    /** v13.32 opens the folded LIVE strip on one tape card, if it is still closed. */
    private fun openLive(anchor: String) {
        scrollUntil(anchor)
        val closed = rule.onAllNodes(hasText("Show ▾", substring = true) and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        if (closed) tapBelow(anchor, "Show ▾", substring = true)
    }

    private fun openTab(label: String) {
        val matcher = hasText(label)
        repeat(5) {
            if (rule.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()) {
                rule.onNode(matcher).performTouchInput { click() }
                rule.waitForIdle()
                return
            }
            appRoot().performTouchInput {
                swipe(Offset(right - 8f, bottom - 8f), Offset(8f, bottom - 8f), durationMillis = 200)
            }
            rule.waitForIdle()
        }
        error("Tab $label is not on screen")
    }

    /** The tape also has a Buy button once a coin is selected. The dialog confirm is the rightmost. */
    private fun tapRightmost(text: String) {
        waitFor(text)
        val nodes = rule.onAllNodes(hasText(text))
        val found = nodes.fetchSemanticsNodes()
        val index = found.indices.maxBy { found[it].boundsInRoot.left }
        nodes[index].performTouchInput { click() }
        rule.waitForIdle()
    }

    /** Clicks the label on the card that owns the anchor, not the same label on another coin. */
    private fun tapBelow(anchor: String, label: String, substring: Boolean = false) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val anchors = rule.onAllNodes(hasText(anchor, substring = true)).fetchSemanticsNodes()
            val buttons = rule.onAllNodes((if (substring) hasText(label, substring = true) else hasText(label)) and hasClickAction())
            val found = buttons.fetchSemanticsNodes()
            if (anchors.isNotEmpty() && found.isNotEmpty()) {
                val anchorTop = anchors.minOf { it.boundsInRoot.top }
                val root = appRoot().fetchSemanticsNode().boundsInRoot
                val below = found.indices.filter { index ->
                    val bounds = found[index].boundsInRoot
                    bounds.top >= anchorTop - 1f && bounds.top >= root.top && bounds.bottom <= root.bottom - 96f
                }
                if (below.isNotEmpty()) {
                    buttons[below.minBy { found[it].boundsInRoot.top }].performTouchInput { click() }
                    rule.waitForIdle()
                    return
                }
            }
            appRoot().performTouchInput {
                swipe(Offset(centerX, bottom * 0.70f), Offset(centerX, bottom * 0.42f), durationMillis = 180)
            }
            rule.waitForIdle()
        }
        error("No clickable \"$label\" on screen under $anchor")
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
                appRoot().performTouchInput {
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
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            dismissAnr()
            // Real-time wait so the desk can answer, then a Compose check. Some notices are in
            // the semantics tree and not in the accessibility text UiAutomator searches.
            if (device.wait(Until.hasObject(By.textContains(text)), 1_000)) return
            val seen = runCatching {
                rule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
            }.getOrDefault(false)
            if (seen) return
        }
        val tree = runCatching { appRoot().printToString(maxDepth = 12) }.getOrElse { it.message ?: "" }
        throw AssertionError("Timed out waiting for \"$text\"\n${tree.take(2500)}")
    }

    /** Back closes the IME only while it is showing. A second back would leave the activity. */
    private fun closeIme() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val shown = device.executeShellCommand("dumpsys input_method").contains("mInputShown=true")
        if (!shown) return
        device.pressBack()
        Thread.sleep(400)
    }

    /** The activity root. A confirm dialog is a second Compose root and must not be used for scrolling. */
    private fun appRoot(): SemanticsNodeInteraction {
        val roots = rule.onAllNodes(isRoot())
        val found = roots.fetchSemanticsNodes()
        val index = found.indices.maxByOrNull { found[it].boundsInRoot.width * found[it].boundsInRoot.height } ?: 0
        return roots[index]
    }

    private fun dismissAnr() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        repeat(3) {
            if (device.findObject(By.textContains("isn't responding")) == null) return
            device.findObject(By.text("Wait"))?.click()
            Thread.sleep(400)
        }
    }

    private fun scrollClickable(matcher: SemanticsMatcher) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < 20_000) {
            dismissAnr()
            val nodes = rule.onAllNodes(matcher)
            val found = nodes.fetchSemanticsNodes()
            if (found.isNotEmpty()) {
                runCatching { nodes[0].performScrollTo() }
                val bounds = runCatching { nodes[0].fetchSemanticsNode().boundsInRoot }.getOrNull()
                if (bounds != null && bounds.height > 1f && bounds.top >= 0f && bounds.bottom <= device.displayHeight - 40) return
            }
            runCatching {
                appRoot().performTouchInput {
                    swipe(Offset(centerX, bottom * 0.7f), Offset(centerX, bottom * 0.35f), durationMillis = 180)
                }
            }
            Thread.sleep(250)
        }
        error("Clickable control was not on screen")
    }

    private fun scrollIntoView(snippet: String) {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < 20_000) {
            val nodes = rule.onAllNodesWithText(snippet, substring = true)
            val found = nodes.fetchSemanticsNodes()
            if (found.isNotEmpty()) {
                val index = found.indices.maxBy { found[it].boundsInRoot.top }
                runCatching { nodes[index].performScrollTo() }
                val bounds = nodes.fetchSemanticsNodes().getOrNull(index)?.boundsInRoot ?: found[index].boundsInRoot
                val root = appRoot().fetchSemanticsNode().boundsInRoot
                val onScreen = bounds.top >= root.top && bounds.bottom <= root.bottom - 120f && bounds.height > 1f
                if (onScreen) return
                val downward = bounds.top > root.bottom - 120f
                appRoot().performTouchInput {
                    if (downward) swipe(Offset(centerX, bottom * 0.72f), Offset(centerX, bottom * 0.32f), durationMillis = 180)
                    else swipe(Offset(centerX, bottom * 0.32f), Offset(centerX, bottom * 0.72f), durationMillis = 180)
                }
            } else {
                appRoot().performTouchInput {
                    swipe(Offset(centerX, bottom * 0.72f), Offset(centerX, bottom * 0.32f), durationMillis = 180)
                }
            }
            Thread.sleep(250)
        }
        error("Could not bring \"$snippet\" on screen")
    }

    private fun clickOnScreen(snippet: String) {
        scrollIntoView(snippet)
        val nodes = rule.onAllNodesWithText(snippet, substring = true)
        val found = nodes.fetchSemanticsNodes()
        nodes[found.indices.maxBy { found[it].boundsInRoot.top }].performTouchInput { click() }
        rule.waitForIdle()
    }

    private fun tapExact(text: String) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            val node = device.findObject(By.text(text))
            if (node != null) {
                node.click()
                rule.waitForIdle()
                return
            }
            Thread.sleep(300)
        }
        error("No exact \"$text\" on screen")
    }

    private fun shot(name: String) {
        dismissAnr()
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val file = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "$name.png")
        check(device.takeScreenshot(file)) { "screenshot $name failed" }
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
