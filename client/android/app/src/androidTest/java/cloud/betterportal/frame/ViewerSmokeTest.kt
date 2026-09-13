package cloud.betterportal.frame

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.view.View
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.ProgressBar
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Requires a clean emulator/device with an Android System WebView provider. No live BF/camera needed. */
@RunWith(AndroidJUnit4::class)
class ViewerSmokeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Before fun useOfflineTestServer() {
        // Activity startup enrolls automatically; instrumentation must never contact production.
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
    }

    @After fun clearTestEnrollment() { ProtectedStore(context).clear() }

    @Test fun setupActivityLaunchesAsABrandedKioskWithEnrollmentInTheMenu() {
        val activity = launch()
        try {
            instrumentation.runOnMainSync {
                val views = descendants(activity.window.decorView)
                assertTrue(views.any { it.contentDescription == "BetterFrame" && it.isShown })
                assertTrue(views.any { it.contentDescription == "Kiosk menu" && it.isShown && it.isFocusable })
                assertFalse("Server entry belongs in Settings", views.any { it is EditText && it.isShown })
                assertFalse(views.filterIsInstance<TextView>().any { it.text.toString() == "Connect display" && it.isShown })
                assertFalse(activity.isFinishing)
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun packagedJniParsesMixedAndLegacyBundlesAndExpandsMainStream() {
        val current = fixture()
        val plan = JSONObject(NativeCore.renderPlan(current.toString(), null, null))
        assertFalse(plan.has("error"))
        assertEquals("3", plan.getString("layoutId"))
        assertEquals("camera", plan.getJSONArray("cells").getJSONObject(0).getString("kind"))
        assertEquals("rtsp://camera/sub", plan.getJSONArray("cells").getJSONObject(0).getJSONObject("camera").getString("uri"))
        assertEquals("web", plan.getJSONArray("cells").getJSONObject(1).getString("kind"))
        val expanded = JSONObject(NativeCore.renderPlan(current.toString(), null, "10"))
        assertEquals(1, expanded.getJSONArray("cells").length())
        assertEquals("rtsp://camera/main", expanded.getJSONArray("cells").getJSONObject(0).getJSONObject("camera").getString("uri"))
        val display = current.getJSONArray("displays").getJSONObject(0)
        current.put("display", display).put("layouts", display.getJSONArray("layouts")).remove("displays")
        val legacy = JSONObject(NativeCore.renderPlan(current.toString(), null, null))
        assertEquals(plan.getString("layoutId"), legacy.getString("layoutId"))
        assertEquals(plan.getJSONArray("cells").toString(), legacy.getJSONArray("cells").toString())
        assertEquals("https://bf.example/dash/lobby", NativeCore.resolveWebUrl("/dash/lobby", "https://bf.example"))
        assertTrue(JSONObject(NativeCore.renderPlan("{}", null, null)).has("error"))
    }

    @Test fun keystoreCacheRoundTripsRejectsTamperingAndCanBeReset() {
        val directory = File(context.cacheDir, "store-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) { override fun getNoBackupFilesDir(): File = directory }
        val store = ProtectedStore(isolated)
        try {
            val original = JSONObject().put("identity", JSONObject().put("kiosk_key", "test-only-key"))
                .put("bundle", "self-contained cached display")
            store.write(original)
            assertEquals(original.toString(), store.read().toString())
            val encrypted = File(directory, "viewer-state.enc")
            assertFalse(encrypted.readText().contains("test-only-key"))
            val bytes = encrypted.readBytes()
            bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
            encrypted.writeBytes(bytes)
            try { store.read(); fail("Tampered enrollment must fail authentication") } catch (_: Exception) { }
            assertTrue("Corrupt enrollment is retained until explicit reset", encrypted.exists())
            store.clear()
            assertEquals(0, store.read().length())
            store.write(original)
            assertEquals(original.toString(), store.read().toString())
        } finally { store.clear(); directory.deleteRecursively() }
    }

    @Test fun htmlRunsAtItsOwnOriginAndReleasesItsBrowser() {
        val activity = launch()
        val tile = AtomicReference<WebTile>()
        val browser = AtomicReference<WebView>()
        try {
            instrumentation.runOnMainSync {
                val cell = JSONObject("""{"id":"html-test","label":"Offline signage","web":{
                    "html":"<html><body data-ready='yes'><video id='signage' autoplay></video><button style='position:fixed;inset:0' onclick='document.body.dataset.tapped=1'>Touch content</button><script>localStorage.setItem('html-test','ready')</script></body></html>",
                    "baseUrl":"https://bf-html-instrumentation.invalid/","localStorage":{}}}
                """)
                tile.set(WebTile(activity, cell) {})
                activity.addContentView(tile.get(), ViewGroup.LayoutParams(-1, -1))
                browser.set(descendants(tile.get()).filterIsInstance<WebView>().first())
                assertFalse(browser.get().settings.allowFileAccess)
                assertFalse(browser.get().settings.allowContentAccess)
                assertTrue(browser.get().settings.javaScriptEnabled)
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            var ready = false
            var diagnostic = "No JavaScript response"
            while (!ready && System.nanoTime() < deadline) {
                val response = AtomicReference<String>()
                val complete = CountDownLatch(1)
                instrumentation.runOnMainSync {
                    browser.get().evaluateJavascript("""
                        JSON.stringify({
                          documentReady: document.body !== null && document.body.dataset.ready === 'yes',
                          origin: location.origin,
                          storageReady: (function() { try { return localStorage.getItem('html-test') === 'ready'; } catch (_) { return false; } })(),
                          muted: !!(document.getElementById('signage') && document.getElementById('signage').muted)
                        })
                    """.trimIndent()) {
                        response.set(it); complete.countDown()
                    }
                }
                assertTrue(complete.await(2, TimeUnit.SECONDS))
                diagnostic = runCatching { org.json.JSONTokener(response.get()).nextValue() as? String }.getOrNull() ?: response.get()
                val result = runCatching { JSONObject(diagnostic) }.getOrNull()
                ready = result != null && result.optBoolean("documentReady") && result.optBoolean("storageReady") &&
                    result.optBoolean("muted") && result.optString("origin") == "https://bf-html-instrumentation.invalid"
                if (!ready) Thread.sleep(100)
            }
            assertTrue("Offline HTML, JS, isolated origin and muted media initialize: $diagnostic", ready)
            instrumentation.runOnMainSync {
                assertTrue("Interaction defaults to enabled", browser.get().isFocusableInTouchMode)
                assertEquals(tile.get().height, browser.get().height)
                assertEquals(tile.get().width, browser.get().width)
                val downTime = SystemClock.uptimeMillis()
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                        browser.get().width / 2f, browser.get().height / 2f, 0)
                    try { browser.get().dispatchTouchEvent(event) } finally { event.recycle() }
                }
            }
            val touched = CountDownLatch(1)
            val touchDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (touched.count != 0L && System.nanoTime() < touchDeadline) {
                instrumentation.runOnMainSync {
                    browser.get().evaluateJavascript("document.body.dataset.tapped === '1'") {
                        if (it == "true") touched.countDown()
                    }
                }
                touched.await(100, TimeUnit.MILLISECONDS)
            }
            assertEquals("HTML receives touch without entering an interaction mode", 0L, touched.count)
            instrumentation.runOnMainSync {
                tile.get().release()
                assertTrue(descendants(tile.get()).none { it is WebView })
            }
        } finally {
            instrumentation.runOnMainSync { tile.get()?.release(); activity.finish() }
        }
    }

    @Test fun cameraConnectionShowsOnlyASpinnerOnBlack() {
        val activity = launch()
        var tile: CameraTile? = null
        try {
            instrumentation.runOnMainSync {
                tile = CameraTile(activity, JSONObject("""{"label":"Fixture camera","camera":{"uri":"rtsp://127.0.0.1:9/live"}}""")) {}
                activity.addContentView(tile!!, ViewGroup.LayoutParams(-1, -1))
                val spinner = descendants(tile!!).filterIsInstance<ProgressBar>().single { it.contentDescription == "Connecting camera" }
                assertTrue(spinner.isShown)
                assertEquals(Color.BLACK, ((spinner.parent as View).background as ColorDrawable).color)
                assertFalse("Connecting camera has no visible text", descendants(tile!!).filterIsInstance<TextView>()
                    .any { it.isShown && it.text.isNotEmpty() })
            }
        } finally { instrumentation.runOnMainSync { tile?.release(); activity.finish() } }
    }

    @Test fun emptyDisplayAndEmptyLayoutKeepTheLogoOnBlack() {
        val activity = launch() as MainActivity
        try {
            instrumentation.runOnMainSync {
                val session = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
                (session.get(activity) as ViewerSession).stop()
                for (layout in listOf("", "3")) {
                    activity.onPlan(JSONObject().put("layoutId", layout).put("cells", org.json.JSONArray()))
                    val views = descendants(activity.window.decorView)
                    val idle = views.single { it.tag == "kiosk-setup" }
                    assertTrue(idle.isShown)
                    assertEquals(Color.BLACK, (idle.background as ColorDrawable).color)
                    assertTrue(views.any { it.contentDescription == "BetterFrame" && it.isShown })
                    assertTrue(views.filterIsInstance<TextView>().any { it.isShown && it.text.toString() ==
                        if (layout.isEmpty()) "go into BetterFrame and assign layouts to this display"
                        else "This layout is empty. Add content to it in BetterFrame." })
                }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun conflictingWebIdentitiesAreIsolatedWithoutLimitingCompatiblePages() {
        fun cell(id: String, url: String, storage: String) = JSONObject().put("id", id).put("kind", "web")
            .put("web", JSONObject().put("url", url).put("localStorage", JSONObject(storage)))
        val first = cell("1", "https://SIGNAGE.example:443/one", """{"screen":"one","mode":"show"}""")
        val compatible = cell("2", "https://signage.example/two", """{"mode":"show","screen":"one"}""")
        val conflicting = cell("3", "https://signage.example/three", """{"screen":"two"}""")
            .put("action", JSONObject().put("type", "layout.switch").put("layoutId", "elsewhere"))
        val empty = cell("4", "https://signage.example/four", "{}")
        val independent = cell("5", "https://other.example/five", """{"screen":"two"}""")
        val result = compatibleWebSessions(listOf(first, compatible, conflicting, empty, independent))
        assertEquals(listOf("web", "web", "placeholder", "placeholder", "web"), result.map { it.getString("kind") })
        assertEquals("expand", result[2].getJSONObject("action").getString("type"))
        assertEquals("web", conflicting.getString("kind")) // Never mutate the saved render plan.
        assertEquals("layout.switch", conflicting.getJSONObject("action").getString("type"))
        assertEquals("web", compatibleWebSessions(listOf(conflicting)).single().getString("kind"))
        assertEquals("web", compatibleWebSessions(listOf(empty)).single().getString("kind"))
    }

    private fun launch(): Activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    private fun descendants(view: View): List<View> = buildList {
        add(view)
        if (view is ViewGroup) for (i in 0 until view.childCount) addAll(descendants(view.getChildAt(i)))
    }
    private fun fixture() = JSONObject("""{
        "kiosk_id":1,"kiosk_name":"Lobby","version":"1","displays":[{
          "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
          "layouts":[{"id":3,"name":"Mixed","grid_cols":2,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
            "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5},
              {"view_id":11,"row":0,"col":1,"row_span":1,"col_span":1,"content_type":"web","web_url":"/dash/lobby"}]}]}],
        "cameras":[{"id":5,"name":"Entrance","type":"onvif","stream_policy":"auto","streams":[
          {"id":6,"role":"main","name":"Main","rtsp_uri":"rtsp://camera/main","encoding":"H264"},
          {"id":7,"role":"sub","name":"Sub","rtsp_uri":"rtsp://camera/sub","encoding":"H264"}]}]}
    """)
}
