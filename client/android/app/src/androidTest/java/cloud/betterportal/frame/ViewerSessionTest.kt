package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class ViewerSessionTest {
    @Test fun secureEnrollmentDisplaysHtmlAndClearsUnassignedCache() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "session-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getApplicationContext(): Context = this
        }
        val unassigned = AtomicBoolean(false)
        val profile = AtomicReference<String?>(null)
        val profileRejected = LinkedBlockingQueue<JSONObject>()
        val interruptHeartbeat = AtomicBoolean(false)
        val offlineRetained = CountDownLatch(1)
        val failures = ConcurrentLinkedQueue<String>()
        val statuses = ConcurrentLinkedQueue<String>()
        val requests = ConcurrentLinkedQueue<String>()
        val htmlPlan = CountDownLatch(1)
        val removedPlan = CountDownLatch(1)
        val cookieInstalled = CountDownLatch(1)
        val enrollmentCleared = CountDownLatch(1)
        val clearing = AtomicBoolean(false)
        val session = AtomicReference<ViewerSession>()
        val actualPlan = AtomicReference<JSONObject>()
        val server = MockWebServer()
        fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code)
            .setHeader("Content-Type", "application/json").setBody(body)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                requests.add(path)
                return try {
                    if (path.startsWith("/api/kiosk/") || path == "/api/pair/ack") {
                        check(request.getHeader("Authorization") == "Bearer test-device-key") { "$path missing kiosk authorization" }
                    } else if (path.startsWith("/api/pair/")) {
                        check(request.getHeader("Authorization") == null) { "$path unexpectedly authenticated" }
                    }
                    when (path) {
                        "/api/pair/initiate" -> {
                            val body = JSONObject(request.body.readUtf8())
                            check(body.getBoolean("secure_claim")) { "Secure enrollment was not requested" }
                            check(body.getJSONArray("capabilities").toString().contains("android-viewer")) { "Android capabilities missing" }
                            json("""{"code":"ABCD12","polling_secret":"test-poll-secret","poll_after_ms":1000}""")
                        }
                        "/api/pair/claim", "/api/pair/ack" -> {
                            val body = JSONObject(request.body.readUtf8())
                            check(body.getString("code") == "ABCD12" && body.getString("polling_secret") == "test-poll-secret") { "Enrollment polling secret was not preserved" }
                            if (path.endsWith("claim")) json("""{"status":"claimed","kiosk_id":"1","kiosk_key":"test-device-key","encrypt_key":"0000000000000000000000000000000000000000000000000000000000000000"}""")
                            else {
                                // The secure device identity must already be durable before acknowledging.
                                check(ProtectedStore(isolated).read().getJSONObject("identity").getString("kiosk_key") == "test-device-key") { "Acknowledged before saving identity" }
                                json("{}")
                            }
                        }
                        "/api/kiosk/heartbeat" -> {
                            val displays = JSONObject(request.body.readUtf8()).getJSONArray("displays")
                            check(displays.length() == 1) { "Single display heartbeat missing" }
                            check(displays.getJSONObject(0).getString("power_state") == "awake") { "Active display must report BF's awake power state" }
                            json(JSONObject().apply { profile.get()?.let { put("viewer_profile", it) } }.toString()).apply {
                                if (interruptHeartbeat.getAndSet(false)) setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                            }
                        }
                        "/api/kiosk/bundle" -> if (unassigned.get()) json("""{"error":"display_unassigned"}""", 409)
                            else json(htmlBundle).setHeader("ETag", "\"fixture-v1\"")
                        "/api/kiosk/display-session" -> {
                            cookieInstalled.countDown()
                            json("{}").setHeader("Set-Cookie", "bf_display_session=test-session; Path=/; HttpOnly; SameSite=Lax")
                        }
                        else -> MockResponse().setResponseCode(404) // This test does not exercise WebSocket commands.
                    }
                } catch (error: Throwable) {
                    failures.add(error.message ?: error.javaClass.simpleName)
                    json("{}", 400)
                }
            }
        }
        server.start()
        // MockWebServer resolves its canonical hostname; do that off Android's UI thread.
        val serverOrigin = server.url("/").toString()
        try {
            // A cache written before profile verification was introduced must not render.
            ProtectedStore(isolated).write(JSONObject().put("server", serverOrigin.trimEnd('/'))
                .put("bundle", htmlBundle).put("etag", "legacy-cache").put("bundle_version", "1"))
            instrumentation.runOnMainSync {
                session.set(ViewerSession(isolated, object : ViewerSession.Listener {
                    override fun onStatus(message: String) {
                        statuses.add(message)
                        if (message.contains("connection unavailable")) offlineRetained.countDown()
                    }
                    override fun onPairing(code: String) {
                        if (code.isBlank() && clearing.get()) enrollmentCleared.countDown()
                    }
                    override fun onPlan(plan: JSONObject) {
                        if (plan.optString("error").contains("android-viewer-v1")) profileRejected.add(plan)
                        else if (plan.optString("error") == "Assign a display to this device in BF") removedPlan.countDown()
                        else if (plan.optJSONArray("cells")?.optJSONObject(0)?.optJSONObject("web")?.optString("html")?.contains("Offline lobby") == true) {
                            actualPlan.set(plan)
                            htmlPlan.countDown()
                        }
                    }
                }))
                session.get().start(serverOrigin)
            }
            for (advertised in listOf(null, "android-viewer-v2")) {
                if (advertised != null) {
                    profile.set(advertised)
                    instrumentation.runOnMainSync { session.get().refresh() }
                }
                assertNotNull("Missing/wrong viewer profile was not rejected; status=$statuses", profileRejected.poll(15, TimeUnit.SECONDS))
                assertFalse("Legacy bundle must never be fetched", requests.contains("/api/kiosk/bundle"))
                assertFalse("Legacy server must not receive a browser session request", requests.contains("/api/kiosk/display-session"))
                assertFalse("Legacy server must not receive a command socket", requests.contains("/ws/kiosk"))
                assertNull("Unverified cache must not render", actualPlan.get())
                assertFalse("Unverified cache must be removed", ProtectedStore(isolated).read().has("bundle"))
            }
            profile.set("android-viewer-v1")
            instrumentation.runOnMainSync { session.get().refresh() }
            assertTrue("HTML plan did not arrive; status=$statuses; failures=$failures", htmlPlan.await(15, TimeUnit.SECONDS))
            assertTrue("Display session was not requested", cookieInstalled.await(5, TimeUnit.SECONDS))
            assertTrue("Protocol assertions: $failures", failures.isEmpty())
            assertEquals("web", actualPlan.get().getJSONArray("cells").getJSONObject(0).getString("kind"))
            assertTrue(ProtectedStore(isolated).read().has("bundle"))
            assertEquals("android-viewer-v1", ProtectedStore(isolated).read().getString("bundle_profile"))
            assertTrue(requests.contains("/api/pair/ack"))
            val fetchedBeforeDowngrade = requests.count { it == "/api/kiosk/bundle" }
            interruptHeartbeat.set(true)
            instrumentation.runOnMainSync { session.get().refresh() }
            assertTrue("Interrupted heartbeat must use offline recovery; status=$statuses", offlineRetained.await(15, TimeUnit.SECONDS))
            assertTrue("Transport failures must preserve a verified cache", ProtectedStore(isolated).read().has("bundle"))
            assertFalse(ProtectedStore(isolated).read().optBoolean("blocked"))
            assertTrue(profileRejected.isEmpty())
            assertEquals(fetchedBeforeDowngrade, requests.count { it == "/api/kiosk/bundle" })
            profile.set(null)
            instrumentation.runOnMainSync { session.get().refresh() }
            assertNotNull("Server downgrade must clear a previously verified display", profileRejected.poll(15, TimeUnit.SECONDS))
            assertEquals(fetchedBeforeDowngrade, requests.count { it == "/api/kiosk/bundle" })
            assertFalse("Downgraded server cache must be removed", ProtectedStore(isolated).read().has("bundle"))
            profile.set("android-viewer-v1")
            unassigned.set(true)
            instrumentation.runOnMainSync { session.get().refresh() }
            assertTrue("Unassignment did not clear the display; status=$statuses", removedPlan.await(15, TimeUnit.SECONDS))
            assertFalse("Unassigned layout must not survive offline restart", ProtectedStore(isolated).read().has("bundle"))
            assertTrue("Protocol assertions: $failures", failures.isEmpty())
            clearing.set(true)
            instrumentation.runOnMainSync { session.get().unpair() }
            assertTrue("Unpair did not finish browser/cache cleanup", enrollmentCleared.await(10, TimeUnit.SECONDS))
            assertEquals(0, ProtectedStore(isolated).read().length())
        } finally {
            instrumentation.runOnMainSync { session.get()?.close() }
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    private val htmlBundle = """{
      "kiosk_id":1,"kiosk_name":"Lobby","version":"1","cameras":[],"displays":[{
        "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
        "layouts":[{"id":3,"name":"Signage","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
          "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<html><body>Offline lobby</body></html>"}]}]}]}
    """
}
