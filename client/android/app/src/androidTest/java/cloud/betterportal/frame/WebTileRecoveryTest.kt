package cloud.betterportal.frame

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class WebTileRecoveryTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val server = MockWebServer()
    private lateinit var assignedUrl: String
    private lateinit var otherUrl: String
    private var activity: Activity? = null
    private var tile: WebTile? = null

    @Before fun prepare() {
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        server.start()
        // MockWebServer.url resolves its canonical hostname; keep DNS off the UI thread.
        assignedUrl = server.url("/assigned").toString()
        otherUrl = server.url("/other").toString()
    }

    @After fun finish() {
        instrumentation.runOnMainSync { tile?.release(); activity?.finish() }
        server.shutdown()
        ProtectedStore(context).clear()
    }

    @Test fun failedRedirectRetriesTheAssignedUrlAndReloadKeepsTheBrowser() {
        val assignedLoads = AtomicInteger()
        val paths = LinkedBlockingQueue<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                paths.offer(path)
                return when (path) {
                    "/assigned" -> if (assignedLoads.incrementAndGet() == 1) {
                        MockResponse().setResponseCode(302).setHeader("Location", "/failed")
                    } else page("assigned-${assignedLoads.get()}")
                    "/failed" -> page("failed").setResponseCode(500)
                    "/other" -> page("other")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val browser = launchTile()
        assertEquals("/assigned", paths.poll(10, TimeUnit.SECONDS))
        assertEquals("/failed", paths.poll(10, TimeUnit.SECONDS))
        assertEquals("The retry must start at the assigned URL", "/assigned", paths.poll(10, TimeUnit.SECONDS))
        awaitDocument(browser, "assigned-2")
        awaitHistorySize(browser, 1)
        instrumentation.runOnMainSync {
            assertSame("Network recovery retains the browser", browser, findBrowser(tile!!))
            browser.loadUrl(otherUrl)
        }
        assertEquals("/other", paths.poll(10, TimeUnit.SECONDS))
        awaitDocument(browser, "other")
        awaitHistorySize(browser, 2)
        instrumentation.runOnMainSync {
            assertTrue("Ordinary page navigation retains back navigation", browser.canGoBack())
        }
        repeat(3) { index ->
            instrumentation.runOnMainSync { tile!!.reload() }
            assertEquals("Manual reload restores the assigned page", "/assigned", paths.poll(10, TimeUnit.SECONDS))
            awaitDocument(browser, "assigned-${index + 3}")
            awaitHistorySize(browser, 1)
            instrumentation.runOnMainSync { assertSame(browser, findBrowser(tile!!)) }
        }
    }

    @Test fun successfulNavigationCancelsAnEarlierErrorRetry() {
        val paths = LinkedBlockingQueue<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths.offer(request.path ?: "")
                return page("assigned")
            }
        }
        val browser = launchTile()
        assertEquals("/assigned", paths.poll(10, TimeUnit.SECONDS))
        awaitDocument(browser, "assigned")
        instrumentation.runOnMainSync {
            // Deliver the documented callback sequence in one UI turn: an error schedules
            // recovery, but a subsequent navigation finishes before the retry timer fires.
            // This avoids depending on emulator/network speed to win that timer race.
            val request = object : WebResourceRequest {
                override fun getUrl(): Uri = Uri.parse(assignedUrl)
                override fun isForMainFrame() = true
                override fun isRedirect() = false
                override fun hasGesture() = false
                override fun getMethod() = "GET"
                override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
            }
            browser.webViewClient.onReceivedHttpError(browser, request,
                WebResourceResponse("text/html", "UTF-8", 500, "Server error", emptyMap(),
                    ByteArrayInputStream(byteArrayOf())))
            browser.webViewClient.onPageStarted(browser, browser.url, null)
            browser.webViewClient.onPageFinished(browser, browser.url)
        }
        assertNull("Recovered content must not be reloaded by the old two-second retry",
            paths.poll(3, TimeUnit.SECONDS))
        instrumentation.runOnMainSync { assertSame(browser, findBrowser(tile!!)) }
    }

    private fun launchTile(): WebView {
        activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val browser = AtomicReference<WebView>()
        instrumentation.runOnMainSync {
            val field = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
            (field.get(activity) as ViewerSession).stop()
            tile = WebTile(activity!!, JSONObject().put("id", "recovery-test").put("web",
                JSONObject().put("url", assignedUrl).put("localStorage", JSONObject()))) {}
            activity!!.addContentView(tile, ViewGroup.LayoutParams(-1, -1))
            browser.set(findBrowser(tile!!))
        }
        return browser.get()
    }

    private fun awaitDocument(browser: WebView, name: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val result = AtomicReference<String>()
            val complete = CountDownLatch(1)
            instrumentation.runOnMainSync {
                browser.evaluateJavascript("document.readyState === 'complete' && document.body.dataset.page === ${JSONObject.quote(name)}") {
                    result.set(it); complete.countDown()
                }
            }
            assertTrue("Browser JavaScript callback completed", complete.await(2, TimeUnit.SECONDS))
            if (result.get() == "true") return
            Thread.sleep(50)
        }
        fail("Expected document did not load: $name")
    }

    private fun awaitHistorySize(browser: WebView, expected: Int) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        var actual = -1
        while (System.nanoTime() < deadline) {
            instrumentation.runOnMainSync { actual = browser.copyBackForwardList().size }
            if (actual == expected) return
            Thread.sleep(50)
        }
        assertEquals("Browser history size after completed navigation", expected, actual)
    }

    private fun page(name: String) = MockResponse().setHeader("Content-Type", "text/html")
        .setHeader("Cache-Control", "no-store")
        .setBody("<html><head><link rel='icon' href='data:,'></head><body data-page='$name'>$name</body></html>")

    private fun findBrowser(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findBrowser(view.getChildAt(index))?.let { return it }
        }
        return null
    }
}
