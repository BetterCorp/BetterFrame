package cloud.betterportal.frame

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentLinkedQueue

@RunWith(AndroidJUnit4::class)
class KioskPresentationTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Before fun isolateEnrollment() {
        // UI tests must never initiate pairing against the production server.
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
    }

    @After fun clearEnrollment() { ProtectedStore(context).clear() }

    @Test fun pairingCodeStaysReadableAndSeparateFromStatusInBothOrientations() {
        launch().use { scenario ->
            for ((orientation, name) in listOf(
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE to "landscape",
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT to "portrait",
            )) {
                scenario.onActivity { it.requestedOrientation = orientation }
                awaitUi(scenario, "Activity did not settle in $name") { activity ->
                    val view = activity.window.decorView
                    val expected = if (orientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)
                        Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
                    activity.resources.configuration.orientation == expected && view.width > 0 && view.height > 0 &&
                        ((view.width > view.height) == (expected == Configuration.ORIENTATION_LANDSCAPE))
                }
                scenario.onActivity { activity ->
                    stopNetworkSession(activity)
                    activity.onPairing("ABC123")
                    activity.onStatus("Waiting for pairing approval")
                }
                awaitUi(scenario, "Pairing code did not finish layout in $name") { activity ->
                    descendants(activity.window.decorView).filterIsInstance<TextView>()
                        .any { it.tag == "pairing-code" && it.isShown && it.width > 0 && it.layout != null }
                }
                scenario.onActivity { activity ->
                    val views = descendants(activity.window.decorView)
                    val logo = views.filterIsInstance<ImageView>().single { it.contentDescription == "BetterFrame" }
                    val drawable = requireNotNull(logo.drawable)
                    assertTrue("Use the full wordmark rather than just the icon", drawable.intrinsicWidth > drawable.intrinsicHeight * 3)
                    assertFullyVisible(logo)
                    val code = views.filterIsInstance<TextView>().single { it.tag == "pairing-code" }
                    assertEquals("ABC123", code.text.toString())
                    assertEquals("Pairing code: A B C 1 2 3", code.contentDescription.toString())
                    assertEquals("Pairing code must fit on one line", 1, code.lineCount)
                    assertPairingGlyphsFit(code)
                    @Suppress("DEPRECATION")
                    val sizeSp = code.textSize / activity.resources.displayMetrics.scaledDensity
                    assertTrue("Pairing code must be readable at a distance ($sizeSp sp)", sizeSp >= 40f)
                    assertFullyVisible(code)
                    assertFullyVisible(views.single { it.tag == "kiosk-details" })
                    assertFalse("Do not put a server form on the kiosk screen", views.any { it is EditText && it.isShown })
                    val menu = views.single { it.contentDescription == "Kiosk menu" }
                    assertTrue(menu.isShown && menu.isFocusable)
                    assertTrue("Menu should be a small overlay", menu.width <= 72 * activity.resources.displayMetrics.density)
                }
                saveScreenshot(scenario, "pairing-$name")
                scenario.onActivity { activity ->
                    activity.onStatus("Connection interrupted — retrying")
                    val views = descendants(activity.window.decorView)
                    assertEquals("ABC123", views.filterIsInstance<TextView>().single { it.tag == "pairing-code" }.text.toString())
                    assertEquals("Connection interrupted — retrying", views.filterIsInstance<TextView>().single { it.tag == "connection-status" }.text.toString())
                    assertNull("TalkBack must read the actual connection status", views.single { it.tag == "connection-status" }.contentDescription)
                }
            }
        }
    }

    @Test fun remoteMenuOpensSettingsWithoutPuttingAnAddressFieldOnTheKiosk() {
        launch().use { scenario ->
            awaitUi(scenario, "Kiosk menu did not appear") { activity ->
                descendants(activity.window.decorView).any { it.contentDescription == "Kiosk menu" && it.isShown }
            }
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MENU)
            awaitAccessibility("Remote Menu did not expose Settings") { root -> root.findAccessibilityNodeInfosByText("Settings").isNotEmpty() }
            clickAccessibleText("Settings")
            awaitAccessibility("Server address must be editable inside Settings") { root ->
                accessibilityDescendants(root).any { it.className?.toString() == EditText::class.java.name && it.isEditable }
            }
            scenario.onActivity { activity ->
                assertFalse("The underlying kiosk must remain free of inline fields", descendants(activity.window.decorView).any { it is EditText })
                assertFalse(activity.isFinishing)
            }
        }
    }

    @Test fun idleGuidanceAndConfigurationErrorsSurviveConnectedStatusUpdates() {
        launch().use { scenario ->
            scenario.onActivity { activity ->
                stopNetworkSession(activity)
                activity.onPlan(JSONObject("""{"rows":1,"cols":1,"cells":[],"layouts":[]}"""))
                activity.onStatus("Connected")
            }
            awaitUi(scenario, "No-content guidance disappeared after connection status changed") { activity ->
                descendants(activity.window.decorView).filterIsInstance<TextView>()
                    .any { it.isShown && it.text.toString().contains("go into BetterFrame and assign layouts to this display") }
            }
            scenario.onActivity { activity ->
                activity.onPlan(JSONObject().put("error", "Display configuration unavailable"))
                activity.onStatus("Connected")
            }
            awaitUi(scenario, "Configuration error disappeared after connection status changed") { activity ->
                descendants(activity.window.decorView).filterIsInstance<TextView>()
                    .any { it.isShown && it.text.toString() == "Display configuration unavailable" }
            }
        }
    }

    @Test fun settingsResetAndConnectPairsWithTheSelectedCustomServer() {
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "existing-test-key")))
        val server = MockWebServer()
        val requestPaths = ConcurrentLinkedQueue<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requestPaths.add(request.requestUrl!!.encodedPath)
                return MockResponse().setBody(when (request.path) {
                "/healthz" -> "{}"
                "/api/pair/initiate" -> """{"code":"ABC123","polling_secret":"test-secret","poll_after_ms":1000}"""
                "/api/pair/claim" -> """{"status":"pending"}"""
                else -> "{}"
                })
            }
        }
        server.start()
        // Resolve localhost outside the UI thread (MockWebServer.url does DNS).
        val target = server.url("/").toString().trimEnd('/')
        val attemptedRemoteHosts = ConcurrentLinkedQueue<String>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val host = chain.request().url.host
            if (host == "localhost" || host == "127.0.0.1") chain.proceed(chain.request())
            else {
                // A regression must be observed without contacting production.
                attemptedRemoteHosts.add(host)
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(503).message("Blocked by instrumentation").body("{}".toResponseBody()).build()
            }
        }.build()
        try {
            launch().use { scenario ->
                lateinit var session: ViewerSession
                scenario.onActivity { activity ->
                    stopNetworkSession(activity)
                    session = ViewerSession(context, activity, http)
                    MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }.set(activity, session)
                    session.start()
                }
                awaitUi(scenario, "Offline kiosk did not become ready for Settings") { activity ->
                    session.serverUrl == "http://127.0.0.1:9" && activity.hasWindowFocus() &&
                        descendants(activity.window.decorView).any {
                            it.contentDescription == "Kiosk menu" && it.isShown && it.isEnabled && it.width > 0 && it.height > 0
                        }
                }
                // The remote entry point has its own test. Exercise the overlay
                // button here after the replacement session and window are ready.
                scenario.onActivity { activity ->
                    val menu = descendants(activity.window.decorView).single { it.contentDescription == "Kiosk menu" }
                    assertTrue("Kiosk menu overlay must open its actions", menu.performClick())
                }
                awaitAccessibility("Kiosk menu overlay did not expose Settings") { root ->
                    accessibilityDescendants(root).any { it.isVisibleToUser && it.text?.toString() == "Settings" }
                }
                clickAccessibleText("Settings")
                awaitAccessibility("Settings server field did not appear") { root ->
                    accessibilityDescendants(root).any { it.isEditable }
                }
                val address = accessibilityDescendants(requireNotNull(instrumentation.uiAutomation.rootInActiveWindow)).first { it.isEditable }
                assertTrue(address.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "http://public.example") }))
                clickAccessibleText("Connect")
                awaitAccessibility("Invalid origin must remain in Settings without prompting a reset") { root ->
                    accessibilityDescendants(root).any { it.isEditable && it.isContentInvalid }
                }
                assertEquals("existing-test-key", ProtectedStore(context).read().getJSONObject("identity").getString("kiosk_key"))
                val correctedAddress = accessibilityDescendants(requireNotNull(instrumentation.uiAutomation.rootInActiveWindow)).first { it.isEditable }
                assertTrue(correctedAddress.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, target) }))
                clickAccessibleText("Connect")
                try {
                    clickAccessibleText("Reset and connect")
                    awaitAccessibility("Reset confirmation was not accepted") { root ->
                        accessibilityDescendants(root).none { it.isVisibleToUser && it.text?.toString() == "Reset this display?" }
                    }
                    awaitUi(scenario, "Reset did not begin pairing with the selected custom server") { activity ->
                        descendants(activity.window.decorView).filterIsInstance<TextView>()
                            .any { it.tag == "pairing-code" && it.isShown && it.text.toString() == "ABC123" }
                    }
                } catch (failure: AssertionError) {
                    throw AssertionError("${failure.message}; ${settingsResetDiagnostics(scenario, session, requestPaths)}", failure)
                }
                assertEquals(target, session.serverUrl)
                assertEquals(target, ProtectedStore(context).read().getString("server"))
                assertTrue("Reset must retain the selected origin instead of contacting the default", attemptedRemoteHosts.isEmpty())
                assertEquals("/healthz", server.takeRequest(2, TimeUnit.SECONDS)?.path)
                assertEquals("/api/pair/initiate", server.takeRequest(2, TimeUnit.SECONDS)?.path)
            }
        } finally { server.shutdown() }
    }

    private fun settingsResetDiagnostics(scenario: ActivityScenario<MainActivity>, session: ViewerSession,
                                         requestPaths: Collection<String>): String {
        var status = ""
        var active = false
        var resetRequested = false
        scenario.onActivity { activity ->
            status = descendants(activity.window.decorView).filterIsInstance<TextView>()
                .firstOrNull { it.tag == "connection-status" }?.text?.toString().orEmpty()
            active = MainActivity::class.java.getDeclaredField("active").apply { isAccessible = true }.getBoolean(activity)
            resetRequested = MainActivity::class.java.getDeclaredField("resetRequested").apply { isAccessible = true }.getBoolean(activity)
        }
        val running = ViewerSession::class.java.getDeclaredField("running").apply { isAccessible = true }.getBoolean(session)
        val clearing = ViewerSession::class.java.getDeclaredField("clearingEnrollment").apply { isAccessible = true }.getBoolean(session)
        val saved = ProtectedStore(context).read()
        // Capture this deterministic fixture before ActivityScenario closes it.
        val captured = runCatching {
            val screenshot = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                val local = File(requireNotNull(context.getExternalFilesDir(null)), "settings-reset-failure.png")
                local.outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
                val shared = "/sdcard/Download/betterframe-kiosk-screenshots"
                for (command in listOf("mkdir -p $shared", "cp ${local.absolutePath} $shared/settings-reset-failure.png")) {
                    ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
                        .bufferedReader().use { it.readText() }
                }
            } finally { screenshot.recycle() }
        }.isSuccess
        // Only public UI status, fixed request paths, and state-presence flags.
        return "status=$status active=$active resetting=$resetRequested running=$running clearing=$clearing " +
            "cleanupMarker=${saved.has("enrollment_cleanup")} identity=${saved.has("identity")} pending=${saved.has("pending")} " +
            "requests=$requestPaths screenshot=$captured"
    }

    @Test fun displayGridUsesTheWholeWindowWithoutPersistentToolbarRows() {
        launch().use { scenario ->
            scenario.onActivity { activity ->
                stopNetworkSession(activity)
                activity.onPlan(JSONObject("""{"layoutId":"3","layoutName":"Lobby","rows":1,"cols":1,"gap":0,
                  "layouts":[{"id":"3","name":"Lobby"},{"id":"4","name":"Details"}],
                  "cells":[{"id":"10","kind":"placeholder","label":"Lobby display","message":"No content assigned",
                    "row":0,"col":0,"rowSpan":1,"colSpan":1}]}"""))
            }
            awaitUi(scenario, "Display grid did not fill the window") { activity ->
                val grid = descendants(activity.window.decorView).firstOrNull { it.tag == "display-grid" }
                grid != null && grid.width > 0 && grid.height > 0 && grid.height == (grid.parent as View).height
            }
            scenario.onActivity { activity ->
                val views = descendants(activity.window.decorView)
                val grid = views.single { it.tag == "display-grid" }
                val parent = grid.parent as View
                assertEquals(0, grid.left)
                assertEquals(0, grid.top)
                assertEquals(parent.width, grid.width)
                assertEquals(parent.height, grid.height)
                assertFalse(views.filterIsInstance<TextView>().any {
                    it.isShown && it.text.toString() in setOf("Layouts", "Refresh", "Settings", "BetterFrame Viewer")
                })
                assertTrue(views.any { it.contentDescription == "Kiosk menu" && it.isShown })
            }
            saveScreenshot(scenario, "display-fullscreen")
        }
    }

    private fun launch(): ActivityScenario<MainActivity> = ActivityScenario.launch(
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun stopNetworkSession(activity: MainActivity) {
        val field = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
        (field.get(activity) as ViewerSession).close()
    }

    private fun awaitUi(scenario: ActivityScenario<MainActivity>, message: String, condition: (MainActivity) -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var ready = false
        while (!ready && System.nanoTime() < deadline) {
            scenario.onActivity { ready = condition(it) }
            if (!ready) Thread.sleep(50)
        }
        assertTrue(message, ready)
    }

    private fun awaitAccessibility(message: String, condition: (AccessibilityNodeInfo) -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        var ready = false
        while (!ready && System.nanoTime() < deadline) {
            instrumentation.uiAutomation.rootInActiveWindow?.let { ready = condition(it) }
            if (!ready) Thread.sleep(50)
        }
        assertTrue(message, ready)
    }

    private fun clickAccessibleText(value: String) {
        // Let dialog layout reach the screen before hit-testing its visible text.
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        awaitAccessibility("$value must be selectable") {
            // Dialog transitions can invalidate a previously obtained node.
            // Resolve both label and row afresh after the UI has become idle.
            instrumentation.waitForIdleSync()
            val root = instrumentation.uiAutomation.rootInActiveWindow ?: return@awaitAccessibility false
            val selected = accessibilityDescendants(root).firstOrNull {
                it.isVisibleToUser && it.isEnabled && it.text?.toString()?.equals(value, ignoreCase = true) == true
            } ?: return@awaitAccessibility false
            // Tap the rendered row/button as a user would. ListView accessibility
            // ACTION_CLICK can reject a node even when the visible row is usable.
            val bounds = Rect()
            selected.getBoundsInScreen(bounds)
            if (bounds.isEmpty) return@awaitAccessibility false
            val downTime = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                    bounds.exactCenterX(), bounds.exactCenterY(), 0)
                try { instrumentation.sendPointerSync(event) } finally { event.recycle() }
            }
            true
        }
    }

    private fun assertFullyVisible(view: View) {
        val visible = Rect()
        assertTrue(view.getGlobalVisibleRect(visible))
        assertEquals("View must not be clipped horizontally", view.width, visible.width())
        assertEquals("View must not be clipped vertically", view.height, visible.height())
    }

    private fun saveScreenshot(scenario: ActivityScenario<MainActivity>, name: String) {
        // An idle main looper can precede drawing and the rotation compositor.
        // Wait for submitted frames, then require the captured display to settle.
        val frames = CountDownLatch(3)
        scenario.onActivity { activity ->
            val view = activity.window.decorView
            view.postOnAnimation(object : Runnable {
                override fun run() {
                    frames.countDown()
                    if (frames.count > 0) view.postOnAnimation(this)
                }
            })
        }
        assertTrue("Kiosk did not render three frames", frames.await(3, TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(250, 3_000)
        fun assertCaptureState() = scenario.onActivity { activity ->
            val views = descendants(activity.window.decorView)
            if (name.startsWith("pairing-")) {
                val code = views.filterIsInstance<TextView>().single { it.tag == "pairing-code" }
                assertEquals("ABC123", code.text.toString())
                assertFullyVisible(code)
                assertPairingGlyphsFit(code)
                assertFullyVisible(views.single { it.tag == "kiosk-details" })
                assertEquals("Waiting for pairing approval", views.filterIsInstance<TextView>()
                    .single { it.tag == "connection-status" }.text.toString())
                val expected = if (name.endsWith("portrait")) Configuration.ORIENTATION_PORTRAIT
                    else Configuration.ORIENTATION_LANDSCAPE
                assertEquals(expected, activity.resources.configuration.orientation)
            } else {
                val grid = views.single { it.tag == "display-grid" }
                assertTrue("Capture must show the display grid", grid.isShown)
                assertFullyVisible(grid)
                assertEquals((grid.parent as View).height, grid.height)
            }
        }
        assertCaptureState()
        val screenshot = stableScreenshot()
        try {
            assertCaptureState()
            if (name.startsWith("pairing-")) assertEquals("Screenshot rotation must match the view",
                name.endsWith("portrait"), screenshot.height > screenshot.width)
            val directory = File(requireNotNull(context.getExternalFilesDir(null)), "screenshots").apply { mkdirs() }
            val saved = File(directory, "$name.png")
            saved.outputStream().use { output ->
                assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
            }
            // Keep evidence outside app storage so test-runner app cleanup cannot
            // delete it before the workflow collects the screenshots.
            val shared = "/sdcard/Download/betterframe-kiosk-screenshots"
            // UiAutomation executes an argv command on Android 10, not a shell.
            // These fixture-owned paths contain no spaces or shell syntax.
            fun execute(command: String) = ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
            execute("mkdir -p $shared")
            execute("cp ${saved.absolutePath} $shared/$name.png")
            assertEquals("Screenshot must survive test-app removal", "$shared/$name.png", execute("ls $shared/$name.png").trim())
        } finally { screenshot.recycle() }
    }

    private fun stableScreenshot(): Bitmap {
        val deadline = SystemClock.uptimeMillis() + 3_000
        var stableSince = SystemClock.uptimeMillis()
        var previous: Bitmap? = null
        try {
            while (SystemClock.uptimeMillis() < deadline) {
                val current = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                if (previous?.sameAs(current) != true) stableSince = SystemClock.uptimeMillis()
                previous?.recycle()
                previous = current
                if (SystemClock.uptimeMillis() - stableSince >= 250) {
                    previous = null
                    return current
                }
                Thread.sleep(50)
            }
            error("Kiosk screenshot did not settle after drawing and rotation")
        } finally { previous?.recycle() }
    }

    private fun assertPairingGlyphsFit(code: TextView) {
        val layout = requireNotNull(code.layout)
        val available = code.width - code.compoundPaddingLeft - code.compoundPaddingRight
        assertEquals("Pairing code must remain a single line", 1, layout.lineCount)
        assertEquals("Pairing code must include every character", code.text.length, layout.getLineEnd(0))
        assertEquals("Pairing code must never be ellipsized", 0, layout.getEllipsisCount(0))
        assertTrue("Pairing glyphs (${layout.getLineWidth(0)}px) must fit the viewport (${available}px)",
            layout.getLineWidth(0) <= available + 1f)
    }

    private fun descendants(view: View): List<View> = buildList {
        add(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) addAll(descendants(view.getChildAt(index)))
    }

    private fun accessibilityDescendants(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = buildList {
        add(node)
        for (index in 0 until node.childCount) node.getChild(index)?.let { addAll(accessibilityDescendants(it)) }
    }
}
