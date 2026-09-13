package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ViewerConnectionTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun isolatedContext(): Pair<Context, File> {
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "connection-test-${System.nanoTime()}").apply { mkdirs() }
        return object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        } to directory
    }

    @Test fun savedCustomServerIsRetainedAndHttpFailuresIdentifyTheFailedRequest() {
        for (stage in listOf("fresh", "pending", "paired")) {
            val (context, directory) = isolatedContext()
            val server = MockWebServer()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(404)
            }
            server.start()
            val origin = server.url("/").toString().trimEnd('/')
            // Discovery has already completed; this test exercises subsequent API failures.
            val state = JSONObject().put("server", origin).put("resolved_server", origin)
            if (stage == "pending") state.put("pending", JSONObject().put("code", "ABC123").put("polling_secret", "test-secret"))
            if (stage == "paired") state.put("identity", JSONObject().put("kiosk_key", "test-device-key"))
            ProtectedStore(context).write(state)
            val statuses = LinkedBlockingQueue<String>()
            val session = ViewerSession(context, object : ViewerSession.Listener {
                override fun onStatus(message: String) { statuses.add(message) }
                override fun onPairing(code: String) {}
                override fun onPlan(plan: JSONObject) {}
            })
            try {
                instrumentation.runOnMainSync { session.start() }
                val failure = statuses.poll(10, TimeUnit.SECONDS) ?: error("No status for $stage")
                assertFalse("No cached display exists at stage $stage: $failure", failure.contains("retaining saved"))
                assertTrue("HTTP failures must not be misreported as lost connectivity: $failure", failure.contains("HTTP 404"))
                assertTrue("Incorrect request at stage $stage: $failure", failure.contains(if (stage == "paired") "heartbeat" else "pairing"))
                assertFalse(failure.contains("connection unavailable"))
                assertEquals(origin, session.serverUrl)
                assertEquals(origin, ProtectedStore(context).read().getString("server"))
                val request = server.takeRequest(2, TimeUnit.SECONDS) ?: error("Saved custom server was not contacted")
                assertEquals(if (stage == "paired") "Bearer test-device-key" else null, request.getHeader("Authorization"))
            } finally {
                instrumentation.runOnMainSync { session.close() }
                server.shutdown()
                directory.deleteRecursively()
            }
        }
    }

    @Test fun freshPairingRecoversFromHeartbeatFailureAndLaterLayoutAssignmentWithoutManualReconnect() {
        val (context, directory) = isolatedContext()
        val requests = ConcurrentLinkedQueue<String>()
        val statuses = ConcurrentLinkedQueue<String>()
        val heartbeatCalls = AtomicInteger()
        val bundleCalls = AtomicInteger()
        val noAssignment = CountDownLatch(1)
        val displayed = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                requests.add(path)
                val response = MockResponse().setHeader("Content-Type", "application/json")
                return when (path) {
                    "/healthz" -> response.setBody("{}")
                    "/api/pair/initiate" -> response.setBody("""{"code":"ABC123","polling_secret":"fixture-secret","poll_after_ms":1000}""")
                    "/api/pair/claim" -> response.setBody("""{"status":"claimed","kiosk_id":"1","kiosk_key":"fixture-device-key","encrypt_key":"0000000000000000000000000000000000000000000000000000000000000000"}""")
                    "/api/pair/ack" -> response.setBody("{}")
                    "/api/kiosk/heartbeat" -> if (heartbeatCalls.incrementAndGet() == 1)
                        response.setResponseCode(500).setBody("""{"error":"private diagnostic must not be displayed"}""")
                        else response.setBody("""{"viewer_profile":"android-viewer-v1"}""")
                    "/api/kiosk/bundle" -> if (bundleCalls.incrementAndGet() == 1)
                        response.setResponseCode(409).setBody("""{"error":"display_unassigned"}""")
                        else response.setBody("""{"kiosk_id":1,"kiosk_name":"Lobby","version":"2","cameras":[],"displays":[{
                          "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
                          "layouts":[{"id":3,"name":"Lobby signage","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
                            "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Assigned later</p>"}]}]}]}""")
                    "/api/kiosk/display-session" -> response.setBody("{}")
                    else -> response.setResponseCode(404)
                }
            }
        }
        server.start()
        val origin = server.url("/").toString().trimEnd('/')
        ProtectedStore(context).write(JSONObject().put("server", origin))
        val session = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) { statuses.add(message) }
            override fun onPairing(code: String) {}
            override fun onPlan(plan: JSONObject) {
                if (plan.optString("error") == "go into BetterFrame and assign layouts to this display") noAssignment.countDown()
                if (plan.optString("layoutId") == "3" && plan.optJSONArray("cells")?.length() == 1) displayed.countDown()
            }
        })
        try {
            // Exactly one start: no refresh, reconnect, lifecycle restart, or
            // WebSocket notification may be needed to pick up the assignment.
            instrumentation.runOnMainSync { session.start() }
            assertTrue("Initial server failure did not recover to assignment guidance: $statuses", noAssignment.await(20, TimeUnit.SECONDS))
            assertTrue("A later layout assignment was not fetched automatically: $statuses", displayed.await(15, TimeUnit.SECONDS))
            assertTrue(statuses.any { it.contains("heartbeat") && it.contains("HTTP 500") && it.contains("Retrying") })
            assertFalse("Do not expose server response bodies", statuses.any { it.contains("private diagnostic") })
            assertFalse("An HTTP server error is not a connectivity failure", statuses.any { it.contains("connection unavailable") })
            assertEquals(1, requests.count { it == "/api/pair/initiate" })
            assertEquals(1, requests.count { it == "/api/pair/claim" })
            assertEquals(1, requests.count { it == "/api/pair/ack" })
            assertTrue(heartbeatCalls.get() >= 3)
            assertTrue(bundleCalls.get() >= 2)
            val saved = ProtectedStore(context).read()
            assertEquals("fixture-device-key", saved.getJSONObject("identity").getString("kiosk_key"))
            assertTrue(saved.has("bundle"))
        } finally {
            instrumentation.runOnMainSync { session.close() }
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test fun redirectsExplainRoutingFailureAndNeverForwardEnrollmentCredentials() {
        val destination = MockWebServer()
        destination.start()
        try {
            for (paired in listOf(false, true)) {
                val (context, directory) = isolatedContext()
                val server = MockWebServer()
                server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", destination.url("/api/redirected")))
                server.start()
                val origin = server.url("/").toString().trimEnd('/')
                // API redirects remain forbidden after the origin has been discovered and pinned.
                val state = JSONObject().put("server", origin).put("resolved_server", origin)
                if (paired) state.put("identity", JSONObject().put("kiosk_key", "test-device-key"))
                else state.put("pending", JSONObject().put("code", "ABC123").put("polling_secret", "test-secret"))
                ProtectedStore(context).write(state)
                val statuses = LinkedBlockingQueue<String>()
                val session = ViewerSession(context, object : ViewerSession.Listener {
                    override fun onStatus(message: String) { statuses.add(message) }
                    override fun onPairing(code: String) {}
                    override fun onPlan(plan: JSONObject) {}
                })
                try {
                    instrumentation.runOnMainSync { session.start() }
                    val failure = statuses.poll(10, TimeUnit.SECONDS) ?: error("Redirect was not reported")
                    assertTrue(failure, failure.contains("server returned a redirect"))
                    assertEquals("Redirect destination must receive neither polling secrets nor bearer tokens", 0, destination.requestCount)
                    assertEquals(state.toString(), ProtectedStore(context).read().toString())
                } finally {
                    instrumentation.runOnMainSync { session.close() }
                    server.shutdown()
                    directory.deleteRecursively()
                }
            }
        } finally { destination.shutdown() }
    }
}
