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
import java.util.concurrent.atomic.AtomicReference

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

    @Test fun resumeDuringEnrollmentCleanupRestartsAfterCleanupWithoutAnotherConnect() {
        enrollmentCleanupAcrossLifecycle(stopAgain = false)
    }

    @Test fun stoppingAgainDuringEnrollmentCleanupCancelsTheDeferredRestart() {
        enrollmentCleanupAcrossLifecycle(stopAgain = true)
    }

    @Test fun destroyedSessionCannotCancelCleanupOrRestoreItsOldEnrollment() {
        enrollmentCleanupAcrossRecreation(restoredMarker = false)
    }

    @Test fun persistedCleanupMarkerBlocksEnrollmentAfterProcessLoss() {
        enrollmentCleanupAcrossRecreation(restoredMarker = true)
    }

    @Test fun failedBrowserCleanupRetainsItsMarkerAndBlocksEnrollmentUntilRetried() {
        enrollmentCleanupAcrossRecreation(restoredMarker = true, cleanupFailsOnce = true)
    }

    private fun enrollmentCleanupAcrossRecreation(restoredMarker: Boolean, cleanupFailsOnce: Boolean = false) {
        val (context, directory) = isolatedContext()
        val cleanupStarted = CountDownLatch(1)
        val cleanupRetried = CountDownLatch(1)
        val cleanupFailed = CountDownLatch(1)
        val completeCleanup = AtomicReference<(Boolean) -> Unit>()
        val cleanupCalls = AtomicInteger()
        val oldCallbacks = AtomicInteger()
        val pairing = CountDownLatch(1)
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return MockResponse().setHeader("Content-Type", "application/json").setBody(when (request.requestUrl!!.encodedPath) {
                    "/api/pair/initiate" -> """{"code":"NEW123","polling_secret":"new-secret","poll_after_ms":1000}"""
                    "/api/pair/claim" -> """{"status":"pending"}"""
                    else -> "{}"
                })
            }
        }
        server.start()
        val target = server.url("/").toString().trimEnd('/')
        val store = ProtectedStore(context)
        store.write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "old-device-key")))
        val cleanup: (Context, (Boolean) -> Unit) -> Unit = { _, done ->
            val attempt = cleanupCalls.incrementAndGet()
            completeCleanup.set(done)
            cleanupStarted.countDown()
            if (attempt == 2) cleanupRetried.countDown()
        }
        val old = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) { oldCallbacks.incrementAndGet() }
            override fun onPairing(code: String) { oldCallbacks.incrementAndGet() }
            override fun onPlan(plan: JSONObject) {}
        }, clearBrowserSessions = cleanup)
        val replacement = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) {
                if (message == "Unable to clear saved enrollment") cleanupFailed.countDown()
            }
            override fun onPairing(code: String) { if (code == "NEW123") pairing.countDown() }
            override fun onPlan(plan: JSONObject) {}
        }, clearBrowserSessions = cleanup)
        try {
            instrumentation.runOnMainSync {
                if (restoredMarker) {
                    // No coordinator job exists: this models a fresh process
                    // recovering the marker left by an interrupted reset.
                    store.write(JSONObject().put("server", target)
                        .put("enrollment_cleanup", "restored-${System.nanoTime()}"))
                } else {
                    old.unpair(target)
                    // Hold the UI thread until persistence, then destroy the
                    // original session before its cleanup runnable can execute.
                    val persisted = CountDownLatch(1)
                    val oldWorker = ViewerSession::class.java.getDeclaredField("worker").apply { isAccessible = true }
                        .get(old) as java.util.concurrent.Executor
                    oldWorker.execute { persisted.countDown() }
                    assertTrue("Reset persistence did not finish", persisted.await(5, TimeUnit.SECONDS))
                    assertTrue("Reset marker was not persisted", store.read().has("enrollment_cleanup"))
                }
                old.close()
                replacement.start()
            }
            assertTrue("Recreation lost browser cleanup", cleanupStarted.await(5, TimeUnit.SECONDS))
            assertEquals("Recreated session must wait for browser cleanup", 0, server.requestCount)
            assertTrue("Cleanup marker must survive until browser completion", store.read().has("enrollment_cleanup"))
            assertFalse(store.read().has("identity"))
            if (cleanupFailsOnce) {
                instrumentation.runOnMainSync { completeCleanup.getAndSet(null).invoke(false) }
                assertTrue("Cleanup failure must be reported", cleanupFailed.await(5, TimeUnit.SECONDS))
                assertTrue("Failed cleanup must retain its recovery marker", store.read().has("enrollment_cleanup"))
                assertEquals("Failed cleanup must never start enrollment", 0, server.requestCount)
                instrumentation.runOnMainSync { replacement.start() }
                assertTrue("Connect must retry the unfinished cleanup", cleanupRetried.await(5, TimeUnit.SECONDS))
                assertEquals(0, server.requestCount)
            }
            instrumentation.runOnMainSync { completeCleanup.getAndSet(null).invoke(true) }
            assertTrue("Recreated display did not resume enrollment", pairing.await(10, TimeUnit.SECONDS))
            assertEquals("Old and recreated instances must share each cleanup attempt", if (cleanupFailsOnce) 2 else 1, cleanupCalls.get())
            assertEquals("Destroyed session must not issue completion callbacks", 0, oldCallbacks.get())
            assertEquals(target, store.read().getString("server"))
            assertFalse("Old cleanup must not overwrite newly saved pairing", store.read().has("enrollment_cleanup"))
            assertEquals("NEW123", store.read().getJSONObject("pending").getString("code"))
            assertFalse(store.read().has("identity"))
            assertTrue(requests.all { it.getHeader("Authorization") == null })
        } finally {
            instrumentation.runOnMainSync {
                old.close()
                replacement.close()
                completeCleanup.getAndSet(null)?.invoke(true)
            }
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    private fun enrollmentCleanupAcrossLifecycle(stopAgain: Boolean) {
        val (context, directory) = isolatedContext()
        val cleanupStarted = CountDownLatch(1)
        val cleanupFinished = CountDownLatch(1)
        val completeCleanup = AtomicReference<(Boolean) -> Unit>()
        val pairing = CountDownLatch(1)
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                val response = MockResponse().setHeader("Content-Type", "application/json")
                return when (request.requestUrl!!.encodedPath) {
                    "/healthz" -> response.setBody("{}")
                    "/api/pair/initiate" -> response.setBody("""{"code":"NEW123","polling_secret":"new-secret","poll_after_ms":1000}""")
                    "/api/pair/claim" -> response.setBody("""{"status":"pending"}""")
                    else -> response.setResponseCode(404)
                }
            }
        }
        server.start()
        val selectedOrigin = server.url("/").toString().trimEnd('/')
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "old-device-key")))
        val session = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) {}
            override fun onPairing(code: String) {
                if (code.isBlank()) cleanupFinished.countDown()
                if (code == "NEW123") pairing.countDown()
            }
            override fun onPlan(plan: JSONObject) {}
        }, clearBrowserSessions = { _, done ->
            completeCleanup.set(done)
            cleanupStarted.countDown()
        })
        try {
            instrumentation.runOnMainSync {
                session.unpair(selectedOrigin)
                // Change generation before the main-thread cleanup even starts.
                session.stop()
                session.start()
            }
            assertTrue("Lifecycle change discarded browser cleanup", cleanupStarted.await(5, TimeUnit.SECONDS))
            assertEquals("Enrollment must wait for browser cleanup", 0, server.requestCount)
            assertEquals(selectedOrigin, ProtectedStore(context).read().getString("server"))
            assertFalse("Old identity must already be removed", ProtectedStore(context).read().has("identity"))
            if (stopAgain) instrumentation.runOnMainSync { session.stop() }
            instrumentation.runOnMainSync { completeCleanup.getAndSet(null).invoke(true) }
            assertTrue("Reset completion must survive lifecycle changes", cleanupFinished.await(5, TimeUnit.SECONDS))
            if (stopAgain) {
                assertNull("Stopped display must not restart on cleanup completion", server.takeRequest(500, TimeUnit.MILLISECONDS))
                instrumentation.runOnMainSync { session.start() }
            }
            assertTrue("Resume was lost while cleanup was pending", pairing.await(10, TimeUnit.SECONDS))
            assertTrue(requests.any { it.requestUrl!!.encodedPath == "/api/pair/initiate" })
            assertTrue("Old enrollment credentials must never be reused", requests.all { it.getHeader("Authorization") == null })
            assertEquals(selectedOrigin, ProtectedStore(context).read().getString("server"))
            assertFalse(ProtectedStore(context).read().has("identity"))
        } finally {
            instrumentation.runOnMainSync { session.close(); completeCleanup.getAndSet(null)?.invoke(true) }
            server.shutdown()
            directory.deleteRecursively()
        }
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

    @Test fun cachedUnassignedDisplayKeepsFastPollingAfterRestartAndNotModifiedResponse() {
        val (context, directory) = isolatedContext()
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val statuses = ConcurrentLinkedQueue<String>()
        val bundleCalls = AtomicInteger()
        val noAssignment = CountDownLatch(1)
        val assigned = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                val response = MockResponse().setHeader("Content-Type", "application/json")
                return when (request.requestUrl!!.encodedPath) {
                    "/api/kiosk/heartbeat" -> response.setBody("""{"viewer_profile":"android-viewer-v1"}""")
                    "/api/kiosk/bundle" -> if (bundleCalls.incrementAndGet() == 1)
                        response.setResponseCode(304)
                        else response.setBody("""{"kiosk_id":1,"kiosk_name":"Lobby","version":"2","cameras":[],"displays":[{
                          "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
                          "layouts":[{"id":3,"name":"New assignment","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,"cells":[]}]}]}""")
                    "/api/kiosk/display-session" -> response.setBody("{}")
                    else -> response.setResponseCode(404) // No WebSocket can trigger a refresh.
                }
            }
        }
        server.start()
        val origin = server.url("/").toString().trimEnd('/')
        ProtectedStore(context).write(JSONObject().put("server", origin).put("resolved_server", origin)
            .put("identity", JSONObject().put("kiosk_key", "fixture-device-key"))
            .put("bundle_profile", "android-viewer-v1").put("etag", "\"unassigned-v1\"")
            .put("bundle", """{"kiosk_id":1,"kiosk_name":"Lobby","version":"1","cameras":[],"displays":[]}"""))
        val session = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) { statuses.add(message) }
            override fun onPairing(code: String) {}
            override fun onPlan(plan: JSONObject) {
                if (plan.optString("error") == "go into BetterFrame and assign layouts to this display") noAssignment.countDown()
                if (plan.optString("layoutId") == "3") assigned.countDown()
            }
        })
        try {
            // Start from a previous run's protected cache; a 304 must not revert
            // assignment polling to the normal 30-second content interval.
            instrumentation.runOnMainSync { session.start() }
            assertTrue("Cached assignment guidance was not restored", noAssignment.await(5, TimeUnit.SECONDS))
            assertTrue("304 lost the fast assignment polling cadence: $statuses", assigned.await(15, TimeUnit.SECONDS))
            assertTrue(statuses.contains("Connected — waiting for assigned layouts"))
            val firstBundle = requests.first { it.requestUrl!!.encodedPath == "/api/kiosk/bundle" }
            assertEquals("\"unassigned-v1\"", firstBundle.getHeader("If-None-Match"))
            assertEquals("Bearer fixture-device-key", firstBundle.getHeader("Authorization"))
            assertTrue(bundleCalls.get() >= 2)
            assertFalse(requests.any { it.requestUrl!!.encodedPath.startsWith("/api/pair/") })
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
