package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ServerDiscoverySessionTest {
    @Test fun credentialEndpointRedirectDoesNotChangeThePinnedServer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "pinned-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getApplicationContext(): Context = this
        }
        val regional = "https://frame-eu.betterportal.net"
        ProtectedStore(isolated).write(JSONObject().put("server", regional).put("resolved_server", regional)
            .put("pending", JSONObject().put("code", "ABCD12").put("polling_secret", "secret")))
        val requests = ConcurrentLinkedQueue<Request>()
        val rejected = CountDownLatch(1)
        val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor { chain ->
                requests.add(chain.request())
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(307).message("fixture")
                    .header("Location", "https://other.example/api/pair/claim").body("".toResponseBody()).build()
            }.build()
        var session: ViewerSession? = null
        try {
            instrumentation.runOnMainSync {
                session = ViewerSession(isolated, object : ViewerSession.Listener {
                    override fun onStatus(message: String) { if (message.contains("redirect")) rejected.countDown() }
                    override fun onPairing(code: String) {}
                    override fun onPlan(plan: JSONObject) {}
                }, http)
                session!!.start()
            }
            assertTrue("Credential redirect was not rejected", rejected.await(10, TimeUnit.SECONDS))
            assertEquals(1, requests.size)
            assertEquals("frame-eu.betterportal.net", requests.single().url.host)
            assertEquals("/api/pair/claim", requests.single().url.encodedPath)
            assertEquals("POST", requests.single().method)
            assertEquals(regional, ProtectedStore(isolated).read().getString("server"))
        } finally {
            instrumentation.runOnMainSync { session?.close() }
            directory.deleteRecursively()
        }
    }

    @Test fun regionalOriginIsPinnedBeforePairingAndSurvivesRestart() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "discovery-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getApplicationContext(): Context = this
        }
        val regional = "https://frame-eu.betterportal.net"
        val requests = ConcurrentLinkedQueue<Request>()
        val failures = ConcurrentLinkedQueue<String>()
        val heartbeats = LinkedBlockingQueue<Boolean>()
        fun http() = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor { chain ->
                val request = chain.request()
                requests.add(request)
                var code = 200
                var location: String? = null
                val body = try {
                    if (request.url.encodedPath == "/healthz") {
                        check(request.method == "GET" && request.body == null)
                        check(request.header("Authorization") == null && request.header("Cookie") == null)
                        if (request.url.host == "frame.betterportal.net") {
                            code = 307; location = "$regional/healthz"
                        }
                        "{}"
                    } else {
                        check(request.url.host == "frame-eu.betterportal.net") { "Credentials sent to entrypoint" }
                        val saved = ProtectedStore(isolated).read()
                        check(saved.getString("server") == regional && saved.getString("resolved_server") == regional) {
                            "Credentials sent before regional origin was persisted"
                        }
                        when (request.url.encodedPath) {
                            "/api/pair/initiate" -> """{"code":"ABCD12","polling_secret":"secret","poll_after_ms":1000}"""
                            "/api/pair/claim" -> """{"status":"claimed","kiosk_id":"1","kiosk_key":"device-key","encrypt_key":"0000000000000000000000000000000000000000000000000000000000000000"}"""
                            "/api/pair/ack" -> "{}"
                            "/api/kiosk/heartbeat" -> {
                                check(request.header("Authorization") == "Bearer device-key")
                                heartbeats.add(true)
                                "{}" // Stops at profile verification; no layout/socket is needed here.
                            }
                            else -> error("Unexpected request ${request.url.encodedPath}")
                        }
                    }
                } catch (error: Throwable) {
                    failures.add(error.message ?: error.javaClass.simpleName)
                    code = 400; "{}"
                }
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("fixture")
                    .body(body.toResponseBody()).apply { location?.let { header("Location", it) } }.build()
            }.build()
        val listener = object : ViewerSession.Listener {
            override fun onStatus(message: String) {}
            override fun onPairing(code: String) {}
            override fun onPlan(plan: JSONObject) {}
        }
        var session: ViewerSession? = null
        try {
            instrumentation.runOnMainSync { session = ViewerSession(isolated, listener, http()); session!!.start() }
            assertNotNull("First regional heartbeat missing: $failures", heartbeats.poll(15, TimeUnit.SECONDS))
            instrumentation.runOnMainSync { session!!.close() }
            instrumentation.runOnMainSync { session = ViewerSession(isolated, listener, http()); session!!.start() }
            assertNotNull("Restart did not use the saved regional server: $failures", heartbeats.poll(15, TimeUnit.SECONDS))
            assertTrue("Protocol failures: $failures", failures.isEmpty())
            assertEquals(regional, session!!.serverUrl)
            assertEquals(1, requests.count { it.url.host == "frame.betterportal.net" })
            assertEquals(2, requests.count { it.url.encodedPath == "/healthz" })
            assertEquals(1, requests.count { it.url.encodedPath == "/api/pair/initiate" })
        } finally {
            instrumentation.runOnMainSync { session?.close() }
            directory.deleteRecursively()
        }
    }
}
