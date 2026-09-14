package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okhttp3.Protocol
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@RunWith(AndroidJUnit4::class)
class ViewerPowerTest {
    @Test fun localSleepAndWakeRemainResponsiveWithBlockedNetwork() {
        val fixture = Fixture(2)
        try {
            fixture.start()
            assertTrue(fixture.networkEntered.await(5, TimeUnit.SECONDS))
            fixture.clock.set(2_999)
            fixture.checkSleep()
            assertFalse(fixture.session.isStandby)
            fixture.clock.set(3_000)
            fixture.checkSleep()
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            assertTrue(fixture.session.isStandby)
            fixture.checkSleep()
            assertNull(fixture.power.poll(100, TimeUnit.MILLISECONDS))
            assertEquals(1L, fixture.releaseNetwork.count)
            fixture.session.setStandby(false)
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.clock.set(4_999)
            fixture.checkSleep()
            assertFalse(fixture.session.isStandby)
            fixture.clock.set(5_000)
            fixture.checkSleep()
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
        } finally { fixture.close() }
    }

    @Test fun disabledSleepAndWrongTargetNeverSleepAndRemoteWakeRenewsDeadline() {
        val fixture = Fixture(0)
        try {
            fixture.start()
            fixture.clock.set(3_600_000)
            fixture.checkSleep()
            assertFalse(fixture.session.isStandby)
            for (target in listOf("999", "", " ", JSONObject.NULL, JSONObject(), true)) {
                fixture.command("standby", target)
                assertFalse("Malformed or mismatched target must not sleep", fixture.session.isStandby)
            }
            fixture.command("standby", "2")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.command("wake", "999")
            assertTrue(fixture.session.isStandby)
            fixture.command("wake", null)
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.command("standby", null)
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.session.recordActivity()
            fixture.session.selectLayout("3")
            fixture.renderer.submit {}.get(5, TimeUnit.SECONDS)
            fixture.act {}
            assertTrue("Input accounting and layout refresh cannot implicitly wake", fixture.session.isStandby)
            fixture.session.stop()
            fixture.command("wake", "2")
            assertTrue("Stopped generations must ignore commands", fixture.session.isStandby)
        } finally { fixture.close() }
    }

    @Test fun standbySurvivesSessionPauseAndReplaysOnResume() {
        val fixture = Fixture(0, blockNetwork = false)
        try {
            fixture.start()
            fixture.session.setStandby(true)
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.act { fixture.session.stop() }
            assertTrue(fixture.session.isStandby)
            fixture.start(expectedStandby = true)
            assertTrue(fixture.session.isStandby)
            fixture.session.setStandby(false)
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
        } finally { fixture.close() }
    }

    @Test fun assignedDisplayCanWakeAfterItsLayoutsAreRemoved() {
        val fixture = Fixture(0, blockNetwork = false)
        try {
            fixture.start()
            fixture.command("standby", "2")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.updateBundle { it.getJSONArray("displays").getJSONObject(0).put("layouts", org.json.JSONArray()) }
            fixture.command("wake", "999")
            assertTrue(fixture.session.isStandby)
            fixture.command("wake", "2")
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.command("standby", "2")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.updateBundle { it.put("displays", org.json.JSONArray()) }
            fixture.command("wake", null)
            assertTrue("An unassigned bundle must not accept power commands", fixture.session.isStandby)
        } finally { fixture.close() }
    }

    @Test fun errorResponseRetainsOnlyCurrentAuthoritativePowerAssignment() {
        val fixture = Fixture(0, blockNetwork = false)
        try {
            fixture.start()
            fixture.command("standby", "2")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.fetchUnassigned(JSONObject().put("display_id", "2"))
            fixture.command("wake", "2")
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.command("standby", "2")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.fetchUnassigned(JSONObject().put("display_id", "3"))
            fixture.command("wake", "2")
            assertTrue("Old assignment must not control a reassigned display", fixture.session.isStandby)
            fixture.command("wake", "3")
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
            fixture.command("standby", "3")
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            for (response in listOf(JSONObject().put("display_id", JSONObject.NULL), JSONObject())) {
                fixture.fetchUnassigned(response)
                fixture.command("wake", null)
                fixture.command("wake", "3")
                assertTrue("No authoritative identity must fail closed", fixture.session.isStandby)
            }
            fixture.fetchUnassigned(JSONObject().put("display_id", "3"))
            fixture.act { fixture.session.stop() }
            fixture.command("wake", "3")
            assertTrue("Power-only assignment must not survive stop", fixture.session.isStandby)
        } finally { fixture.close() }
    }

    @Test fun websocketPowerBypassesBlockedHttpAndRejectsStaleSources() {
        val fixture = Fixture(0)
        val rendererBlocked = CountDownLatch(1)
        val releaseRenderer = CountDownLatch(1)
        try {
            fixture.start()
            val original = TestSocket()
            val replacement = TestSocket()
            val listener = ViewerSession::class.java.getDeclaredMethod("socketListener", Int::class.javaPrimitiveType)
                .apply { isAccessible = true }.invoke(fixture.session, fixture.field("generation")) as WebSocketListener
            val socketField = ViewerSession::class.java.getDeclaredField("socket").apply { isAccessible = true }
            socketField.set(fixture.session, original)
            fun send(socket: WebSocket, type: String) = listener.onMessage(socket, """{"type":"$type","display_id":"2"}""")
            send(original, "standby")
            assertEquals(true, fixture.power.poll(2, TimeUnit.SECONDS))
            send(original, "wake")
            assertEquals(false, fixture.power.poll(2, TimeUnit.SECONDS))
            assertEquals("Socket control must not wait for the HTTP worker", 1L, fixture.releaseNetwork.count)
            fixture.session.setStandby(true)
            assertEquals(true, fixture.power.poll(2, TimeUnit.SECONDS))
            fixture.renderer.execute { rendererBlocked.countDown(); releaseRenderer.await(5, TimeUnit.SECONDS) }
            assertTrue(rendererBlocked.await(2, TimeUnit.SECONDS))
            send(original, "wake")
            socketField.set(fixture.session, replacement)
            releaseRenderer.countDown()
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            fixture.act {}
            assertTrue("Replacement must invalidate already queued source", fixture.session.isStandby)
            send(original, "wake")
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            assertTrue(fixture.session.isStandby)
            send(replacement, "wake")
            assertEquals(false, fixture.power.poll(2, TimeUnit.SECONDS))
            listener.onFailure(replacement, IOException("Disconnected"), null)
            send(replacement, "standby")
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            assertFalse("Failed sockets must be rejected even while HTTP is blocked", fixture.session.isStandby)
            socketField.set(fixture.session, original)
            fixture.act { fixture.session.stop() }
            send(original, "standby")
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            assertFalse("Old generation must be rejected", fixture.session.isStandby)
        } finally { releaseRenderer.countDown(); fixture.close() }
    }

    @Test fun websocketAcknowledgesCommittedPowerAndRejectedTargets() {
        val fixture = Fixture(0)
        try {
            fixture.start()
            val current = TestSocket()
            val stale = TestSocket()
            val listener = ViewerSession::class.java.getDeclaredMethod("socketListener", Int::class.javaPrimitiveType)
                .apply { isAccessible = true }.invoke(fixture.session, fixture.field("generation")) as WebSocketListener
            val socketField = ViewerSession::class.java.getDeclaredField("socket").apply { isAccessible = true }
            socketField.set(fixture.session, current)
            fun send(socket: WebSocket, request: String, type: String, target: Any?) {
                val message = JSONObject().put("type", type).put("request_id", request)
                if (target != null) message.put("display_id", target)
                listener.onMessage(socket, message.toString())
            }
            fun acknowledgement(request: String, accepted: Boolean) {
                val result = JSONObject(current.sent.poll(2, TimeUnit.SECONDS) ?: throw AssertionError("Expected power acknowledgement"))
                assertEquals("power-result", result.getString("type"))
                assertEquals(request, result.getString("request_id"))
                assertEquals(accepted, result.getBoolean("accepted"))
            }
            send(current, "sleep", "standby", "2")
            acknowledgement("sleep", true)
            assertTrue("Positive ACK follows state commit", fixture.session.isStandby)
            send(current, "wrong-display", "wake", "3")
            acknowledgement("wrong-display", false)
            assertTrue(fixture.session.isStandby)
            send(current, "invalid-target", "wake", JSONObject.NULL)
            acknowledgement("invalid-target", false)
            assertTrue(fixture.session.isStandby)
            send(current, "wake", "wake", null)
            acknowledgement("wake", true)
            assertFalse(fixture.session.isStandby)
            send(stale, "stale", "standby", "2")
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            assertTrue(stale.sent.isEmpty())
            assertFalse(fixture.session.isStandby)
            send(current, "x".repeat(129), "standby", "2")
            fixture.renderer.submit {}.get(2, TimeUnit.SECONDS)
            assertTrue(current.sent.isEmpty())
            assertFalse("Malformed correlation IDs must not mutate power", fixture.session.isStandby)
            assertEquals("ACK must bypass blocked HTTP", 1L, fixture.releaseNetwork.count)
        } finally { fixture.close() }
    }

    private class TestSocket : WebSocket {
        val sent = LinkedBlockingQueue<String>()
        override fun request(): Request = Request.Builder().url("http://127.0.0.1:9/api/kiosk/ws").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean { sent.add(text); return true }
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() {}
    }

    @Test fun freshInputInvalidatesQueuedSleepBeforeItCommits() {
        val fixture = Fixture(2)
        try {
            fixture.start()
            fixture.clock.set(3_000)
            fixture.act {
                // Hold UI delivery while the renderer evaluates the expired deadline.
                fixture.renderer.submit { fixture.invokeSleep() }.get(5, TimeUnit.SECONDS)
                fixture.session.recordActivity()
            }
            fixture.act {}
            assertFalse(fixture.session.isStandby)
            assertNull(fixture.power.poll(100, TimeUnit.MILLISECONDS))
        } finally { fixture.close() }
    }

    @Test fun standbyRetainsNetworkAndReportsItsStateAndCapability() {
        val fixture = Fixture(0, blockNetwork = false)
        try {
            fixture.start()
            fixture.session.setStandby(true)
            assertEquals(true, fixture.power.poll(5, TimeUnit.SECONDS))
            // Invoke the real heartbeat on its owner executor, independent of backoff.
            val worker = fixture.field("worker") as ExecutorService
            worker.submit {
                runCatching { ViewerSession::class.java.getDeclaredMethod("heartbeat").apply { isAccessible = true }.invoke(fixture.session) }
            }.get(5, TimeUnit.SECONDS)
            val reports = mutableListOf<JSONObject>()
            fixture.heartbeats.drainTo(reports)
            val sleeping = reports.last()
            assertEquals("standby", sleeping.getJSONArray("displays").getJSONObject(0).getString("power_state"))
            assertTrue(sleeping.getJSONArray("capabilities").toString().contains("android-standby-v1"))
            assertTrue(fixture.field("running") as Boolean)
            fixture.session.setStandby(false)
            assertEquals(false, fixture.power.poll(5, TimeUnit.SECONDS))
        } finally { fixture.close() }
    }

    private class Fixture(timeout: Int, blockNetwork: Boolean = true) {
        private val instrumentation = InstrumentationRegistry.getInstrumentation()
        private val directory = File(instrumentation.targetContext.cacheDir, "power-${System.nanoTime()}").apply { mkdirs() }
        private val context = object : ContextWrapper(instrumentation.targetContext) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        }
        val clock = AtomicLong(1_000)
        val networkEntered = CountDownLatch(1)
        val releaseNetwork = CountDownLatch(if (blockNetwork) 1 else 0)
        val power = LinkedBlockingQueue<Boolean>()
        val heartbeats = LinkedBlockingQueue<JSONObject>()
        private val bundleErrors = LinkedBlockingQueue<JSONObject>()
        private val plans = LinkedBlockingQueue<JSONObject>()
        val session: ViewerSession
        val renderer get() = field("renderer") as ExecutorService
        init {
            val bundle = """{"kiosk_id":1,"kiosk_name":"Power display","version":"1","displays":[{
              "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,
              "sleep_timeout_seconds":$timeout,"default_layout_id":3,"layouts":[{
                "id":3,"name":"HTML","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,
                "resets_idle_timer":true,"cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,
                "content_type":"html","html_content":"<p>Display</p>"}]}]}],"cameras":[]}"""
            ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
                .put("resolved_server", "http://127.0.0.1:9")
                .put("identity", JSONObject().put("kiosk_key", "test-device-key"))
                .put("bundle_profile", "android-viewer-v1").put("bundle", bundle))
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                if (chain.request().url.encodedPath == "/api/kiosk/bundle") {
                    val error = bundleErrors.poll() ?: throw IOException("Unexpected bundle request")
                    return@addInterceptor Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                        .code(409).message("Conflict").body(error.toString().toResponseBody("application/json".toMediaType())).build()
                }
                if (chain.request().url.encodedPath == "/api/kiosk/heartbeat") {
                    val buffer = Buffer()
                    chain.request().body!!.writeTo(buffer)
                    heartbeats.add(JSONObject(buffer.readUtf8()))
                }
                networkEntered.countDown()
                releaseNetwork.await(30, TimeUnit.SECONDS)
                throw IOException("Fixture network unavailable")
            }.build()
            session = ViewerSession(context, object : ViewerSession.Listener {
                override fun onStatus(message: String) {}
                override fun onPairing(code: String) {}
                override fun onPlan(plan: JSONObject) { plans.add(plan) }
                override fun onStandbyChanged(standby: Boolean) { power.add(standby) }
            }, http, monotonicTime = clock::get)
        }
        fun field(name: String): Any? = ViewerSession::class.java.getDeclaredField(name).apply { isAccessible = true }.get(session)
        fun act(action: () -> Unit) = instrumentation.runOnMainSync(action)
        fun start(expectedStandby: Boolean = false) {
            act { session.start() }
            assertEquals("3", plans.poll(5, TimeUnit.SECONDS)?.optString("layoutId"))
            assertEquals(expectedStandby, power.poll(5, TimeUnit.SECONDS))
            assertTrue(networkEntered.await(5, TimeUnit.SECONDS))
            (field("idleLoop") as ScheduledFuture<*>).cancel(false)
            renderer.submit {}.get(5, TimeUnit.SECONDS)
        }
        fun updateBundle(update: (JSONObject) -> Unit) {
            val worker = field("worker") as ExecutorService
            worker.submit {
                val state = field("state") as JSONObject
                val bundle = JSONObject(state.getString("bundle"))
                update(bundle)
                state.put("bundle", bundle.toString())
                ViewerSession::class.java.getDeclaredMethod("emitPlan").apply { isAccessible = true }.invoke(session)
            }.get(5, TimeUnit.SECONDS)
            assertNotNull("Updated assignment must render even if it has no content", plans.poll(5, TimeUnit.SECONDS))
        }
        fun fetchUnassigned(response: JSONObject) {
            bundleErrors.add(response.put("error", "display_unassigned"))
            val worker = field("worker") as ExecutorService
            worker.submit {
                ViewerSession::class.java.getDeclaredField("profileVerified").apply { isAccessible = true }.setBoolean(session, true)
                ViewerSession::class.java.getDeclaredMethod("bundle").apply { isAccessible = true }.invoke(session)
            }.get(5, TimeUnit.SECONDS)
            assertEquals("go into BetterFrame and assign layouts to this display", plans.poll(5, TimeUnit.SECONDS)?.optString("error"))
            assertNull("409 must remove playback state", field("renderSnapshot"))
            assertFalse("409 must discard cached content", (field("state") as JSONObject).has("bundle"))
        }
        fun invokeSleep() {
            ViewerSession::class.java.getDeclaredMethod("checkSleep", Int::class.javaPrimitiveType)
                .apply { isAccessible = true }.invoke(session, field("generation"))
        }
        fun checkSleep() { renderer.submit { invokeSleep() }.get(5, TimeUnit.SECONDS); act {} }
        fun command(type: String, target: Any?) {
            val command = JSONObject().put("type", type)
            if (target != null) command.put("display_id", target)
            ViewerSession::class.java.getDeclaredMethod("applyPowerCommand", JSONObject::class.java)
                .apply { isAccessible = true }.invoke(session, command)
            renderer.submit {}.get(5, TimeUnit.SECONDS)
            act {}
        }
        fun close() { releaseNetwork.countDown(); act { session.close() }; directory.deleteRecursively() }
    }
}
