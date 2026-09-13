package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.ExecutorService

@RunWith(AndroidJUnit4::class)
class ViewerIdleTest {
    @Test fun idleReturnAndActivityRemainResponsiveDuringBlockedHeartbeat() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        val directory = File(target.cacheDir, "idle-test-${System.nanoTime()}").apply { mkdirs() }
        val context = object : ContextWrapper(target) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        }
        val networkBlocked = CountDownLatch(1)
        val releaseNetwork = CountDownLatch(1)
        val clock = AtomicLong(1_000)
        val plans = LinkedBlockingQueue<JSONObject>()
        val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor {
                networkBlocked.countDown()
                releaseNetwork.await(30, TimeUnit.SECONDS)
                throw IOException("Fixture heartbeat unavailable")
            }.build()
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("resolved_server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "test-device-key"))
            .put("bundle_profile", "android-viewer-v1").put("bundle", bundle))
        val session = ViewerSession(context, object : ViewerSession.Listener {
            override fun onStatus(message: String) {}
            override fun onPairing(code: String) {}
            override fun onPlan(plan: JSONObject) { plans.add(plan) }
        }, http, monotonicTime = clock::get)
        fun awaitPlan(layout: String, expanded: Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < deadline) {
                val plan = plans.poll(100, TimeUnit.MILLISECONDS) ?: continue
                val hasExpansion = plan.optString("expandedCellId").let { it.isNotBlank() && it != "null" }
                if (plan.optString("layoutId") == layout && hasExpansion == expanded) return
            }
            fail("No plan for layout=$layout expanded=$expanded while heartbeat is blocked")
        }
        fun act(action: () -> Unit) = instrumentation.runOnMainSync(action)
        try {
            act { session.start() }
            awaitPlan("3", false)
            assertTrue(networkBlocked.await(5, TimeUnit.SECONDS))

            // Expansion of the default camera grid must still expire locally.
            act { session.expand("10") }
            awaitPlan("3", true)
            clock.addAndGet(2_001)
            awaitPlan("3", false)
            assertEquals("Idle must not wait for heartbeat completion", 1L, releaseNetwork.count)

            // The HTML layout overrides the display timeout. Real page input
            // renews inactivity without changing the layout or waiting for I/O.
            act { session.selectLayout("4") }
            awaitPlan("4", false)
            clock.addAndGet(2_500)
            act { session.recordActivity() }
            clock.addAndGet(2_500)
            assertNull("Recent page input must postpone idle return", plans.poll(750, TimeUnit.MILLISECONDS))
            clock.addAndGet(501)
            awaitPlan("3", false)

            // A sticky layout can collapse its camera without switching away.
            act { session.selectLayout("5") }
            awaitPlan("5", false)
            act { session.expand("10") }
            awaitPlan("5", true)
            clock.addAndGet(2_001)
            awaitPlan("5", false)
            clock.addAndGet(10_000)
            assertNull("Sticky layout must remain selected", plans.poll(750, TimeUnit.MILLISECONDS))

            // An explicit layout zero overrides the nonzero display timeout.
            act { session.selectLayout("6") }
            awaitPlan("6", false)
            act { session.expand("10") }
            awaitPlan("6", true)
            clock.addAndGet(3_600_000)
            assertNull("Disabled idle must retain expansion", plans.poll(750, TimeUnit.MILLISECONDS))

            act { session.selectLayout("3") }
            awaitPlan("3", false)
            act { session.expand("10") }
            awaitPlan("3", true)
            act { session.stop() }
            clock.addAndGet(10_000)
            assertNull("Stopped sessions must not emit idle plans", plans.poll(750, TimeUnit.MILLISECONDS))
        } finally {
            releaseNetwork.countDown()
            act { session.close() }
            directory.deleteRecursively()
        }
    }

    @Test fun freshInputBetweenIdleSampleAndCommitPreventsExpiry() {
        val clock = AtomicLong(1_000)
        val intercept = AtomicBoolean(false)
        val sampled = CountDownLatch(1)
        val releaseSample = CountDownLatch(1)
        val fixture = IdleFixture {
            val sampledTime = clock.get()
            if (sampledTime >= 3_001 && android.os.Looper.myLooper() != android.os.Looper.getMainLooper() && intercept.compareAndSet(true, false)) {
                sampled.countDown()
                releaseSample.await(10, TimeUnit.SECONDS)
            }
            sampledTime
        }
        try {
            fixture.start()
            fixture.act { fixture.session.expand("10") }
            assertEquals("10", fixture.plan().getString("expandedCellId"))
            intercept.set(true)
            clock.set(3_001)
            assertTrue("Idle clock sample reached the decision boundary", sampled.await(5, TimeUnit.SECONDS))
            fixture.act { fixture.session.recordActivity() }
            releaseSample.countDown()
            assertNull("New input wins over the older idle sample", fixture.plans.poll(750, TimeUnit.MILLISECONDS))
            assertNull(fixture.idle.poll(100, TimeUnit.MILLISECONDS))
            clock.addAndGet(2_001)
            assertTrue(fixture.plan().isNull("expandedCellId"))
            assertNotNull(fixture.idle.poll(5, TimeUnit.SECONDS))
        } finally { releaseSample.countDown(); fixture.close() }
    }

    @Test fun defaultLayoutNotifiesOnceAndQueuedExpiryCannotDismissAfterFreshInput() {
        val clock = AtomicLong(1_000)
        val sampled = AtomicReference<CountDownLatch?>()
        val fixture = IdleFixture {
            clock.get().also {
                if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) sampled.getAndSet(null)?.countDown()
            }
        }
        val unblockMain = CountDownLatch(1)
        try {
            fixture.start()
            clock.addAndGet(2_001)
            assertNotNull("Default unexpanded layout still closes idle UI", fixture.idle.poll(5, TimeUnit.SECONDS))
            assertNull("One notification per activity revision", fixture.idle.poll(750, TimeUnit.MILLISECONDS))
            assertNull("Default layout does not need rebuilding", fixture.plans.poll(100, TimeUnit.MILLISECONDS))
            fixture.act { fixture.session.recordActivity() }

            // Hold main-thread delivery while the renderer commits the next expiry.
            // Input on that same main thread then invalidates the queued callback.
            val mainBlocked = CountDownLatch(1)
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                mainBlocked.countDown()
                unblockMain.await(10, TimeUnit.SECONDS)
                fixture.session.recordActivity()
            }
            assertTrue(mainBlocked.await(5, TimeUnit.SECONDS))
            val nextSample = CountDownLatch(1)
            clock.addAndGet(2_001)
            sampled.set(nextSample)
            assertTrue(nextSample.await(5, TimeUnit.SECONDS))
            val renderer = ViewerSession::class.java.getDeclaredField("renderer").apply { isAccessible = true }
                .get(fixture.session) as ExecutorService
            renderer.submit {}.get(5, TimeUnit.SECONDS) // Fence after the sampled idle task.
            unblockMain.countDown()
            fixture.act {} // Main-thread input above has completed before examining callbacks.
            assertNull("Fresh input invalidates a queued idle dismissal", fixture.idle.poll(750, TimeUnit.MILLISECONDS))
            clock.addAndGet(2_001)
            assertNotNull("New inactivity gets its own notification", fixture.idle.poll(5, TimeUnit.SECONDS))
        } finally { unblockMain.countDown(); fixture.close() }
    }

    private inner class IdleFixture(monotonicTime: () -> Long) {
        private val instrumentation = InstrumentationRegistry.getInstrumentation()
        private val target = instrumentation.targetContext
        private val directory = File(target.cacheDir, "idle-boundary-${System.nanoTime()}").apply { mkdirs() }
        private val context = object : ContextWrapper(target) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        }
        private val releaseNetwork = CountDownLatch(1)
        val plans = LinkedBlockingQueue<JSONObject>()
        val idle = LinkedBlockingQueue<Boolean>()
        val session: ViewerSession
        init {
            ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
                .put("resolved_server", "http://127.0.0.1:9")
                .put("identity", JSONObject().put("kiosk_key", "test-device-key"))
                .put("bundle_profile", "android-viewer-v1").put("bundle", bundle))
            val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                .addInterceptor {
                    releaseNetwork.await(30, TimeUnit.SECONDS)
                    throw IOException("Fixture heartbeat unavailable")
                }.build()
            session = ViewerSession(context, object : ViewerSession.Listener {
                override fun onStatus(message: String) {}
                override fun onPairing(code: String) {}
                override fun onPlan(plan: JSONObject) { plans.add(plan) }
                override fun onIdleReturn() { idle.add(true) }
            }, http, monotonicTime = monotonicTime)
        }
        fun act(action: () -> Unit) = instrumentation.runOnMainSync(action)
        fun start() { act { session.start() }; assertEquals("3", plan().getString("layoutId")) }
        fun plan(): JSONObject = plans.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("Expected render plan")
        fun close() {
            releaseNetwork.countDown()
            act { session.close() }
            directory.deleteRecursively()
        }
    }

    private val bundle = """{"kiosk_id":1,"kiosk_name":"Idle display","version":"1","displays":[{
      "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":2,"sleep_timeout_seconds":0,"default_layout_id":3,
      "layouts":[
        {"id":3,"name":"Default cameras","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
         "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5}]},
        {"id":4,"name":"Interactive HTML","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":false,"resets_idle_timer":true,"idle_timeout_seconds":3,
         "cells":[{"view_id":20,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Interactive</p>"}]},
        {"id":5,"name":"Sticky cameras","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":false,"resets_idle_timer":false,
         "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5}]},
        {"id":6,"name":"Idle disabled","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":false,"resets_idle_timer":true,"idle_timeout_seconds":0,
         "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5}]}]}],
      "cameras":[{"id":5,"name":"Entrance","type":"onvif","stream_policy":"auto","streams":[
        {"id":6,"role":"main","name":"Main","rtsp_uri":"rtsp://camera/main","encoding":"H264"}]}]}"""
}
