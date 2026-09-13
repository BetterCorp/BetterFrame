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
import java.util.concurrent.TimeUnit

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

    @Test fun savedCustomServerIsRetainedAndFailuresDescribeActualEnrollmentState() {
        for (stage in listOf("fresh", "pending", "paired")) {
            val (context, directory) = isolatedContext()
            val server = MockWebServer()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(404)
            }
            server.start()
            val origin = server.url("/").toString().trimEnd('/')
            val state = JSONObject().put("server", origin)
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
                assertTrue("Incorrect status at stage $stage: $failure", failure.contains(when (stage) {
                    "fresh" -> "Unable to start pairing"
                    "pending" -> "retrying pairing"
                    else -> "no display configuration saved yet"
                }))
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

    @Test fun redirectsExplainRoutingFailureAndNeverForwardEnrollmentCredentials() {
        val destination = MockWebServer()
        destination.start()
        try {
            for (paired in listOf(false, true)) {
                val (context, directory) = isolatedContext()
                val server = MockWebServer()
                server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", destination.url("/api/redirected")))
                server.start()
                val state = JSONObject().put("server", server.url("/").toString().trimEnd('/'))
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
