package cloud.betterportal.frame

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebViewClient
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
import java.util.concurrent.ConcurrentLinkedQueue
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
    private lateinit var failedUrl: String
    private val callbacks = ConcurrentLinkedQueue<String>()
    private var activity: Activity? = null
    private var tile: WebTile? = null

    @Before fun prepare() {
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        server.start()
        // MockWebServer.url resolves its canonical hostname; keep DNS off the UI thread.
        assignedUrl = server.url("/assigned").toString()
        otherUrl = server.url("/other").toString()
        failedUrl = server.url("/failed").toString()
    }

    @After fun finish() {
        instrumentation.runOnMainSync { tile?.release(); activity?.finish() }
        server.shutdown()
        ProtectedStore(context).clear()
    }

    @Test fun failedRedirectReplacesFailedBrowserAndManualReloadKeepsRecoveredBrowser() {
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
        var browser = launchTile()
        val failedBrowser = browser
        assertEquals("/assigned", paths.poll(10, TimeUnit.SECONDS))
        assertEquals("/failed", paths.poll(10, TimeUnit.SECONDS))
        val retried = paths.poll(10, TimeUnit.SECONDS)
        assertEquals("The retry must start at the assigned URL; callbacks=$callbacks", "/assigned", retried)
        instrumentation.runOnMainSync { browser = findBrowser(tile!!)!! }
        assertNotSame("Automatic recovery isolates old navigation callbacks", failedBrowser, browser)
        awaitDocument(browser, "assigned-2")
        awaitHistorySize(browser, 1)
        instrumentation.runOnMainSync {
            assertSame("The recovered browser remains active", browser, findBrowser(tile!!))
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
            deliverHttpError(browser, assignedUrl)
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            browser.webViewClient.onPageStarted(browser, browser.url, null)
            browser.webViewClient.onPageCommitVisible(browser, browser.url)
            browser.webViewClient.onPageFinished(browser, browser.url)
        }
        assertNull("Recovered content must not be reloaded by the old two-second retry",
            paths.poll(3, TimeUnit.SECONDS))
        instrumentation.runOnMainSync { assertSame(browser, findBrowser(tile!!)) }
    }

    @Test fun failedRedirectSurvivesLateStartAndEarlierUrlFinish() {
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
            deliverHttpError(browser, failedUrl)
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            browser.webViewClient.onPageStarted(browser, failedUrl, null)
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            browser.webViewClient.onPageFinished(browser, failedUrl)
        }
        val retried = paths.poll(10, TimeUnit.SECONDS)
        assertEquals("Late redirect callbacks must retain recovery; callbacks=$callbacks", "/assigned", retried)
        val recovered = AtomicReference<WebView>()
        instrumentation.runOnMainSync { recovered.set(findBrowser(tile!!)!!) }
        assertNotSame(browser, recovered.get())
        awaitDocument(recovered.get(), "assigned")
    }

    @Test fun finishedWithoutVisualCommitRetainsWatchdogAndRecovers() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = page("assigned")
        }
        val browser = launchTile()
        awaitDocument(browser, "assigned")
        instrumentation.runOnMainSync {
            fun timeout(): Runnable? = WebTile::class.java.getDeclaredField("loadTimeout")
                .apply { isAccessible = true }.get(tile) as Runnable?
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            val watchdog = timeout()!!
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            assertSame("Completion without pixels must retain recovery", watchdog, timeout())
            assertEquals(View.VISIBLE, findSpinner(tile!!)!!.visibility)
            // The opposite callback order must also complete once pixels arrive.
            browser.webViewClient.onPageCommitVisible(browser, assignedUrl)
            assertNull(timeout())
            assertEquals(View.GONE, (findSpinner(tile!!)!!.parent as View).visibility)
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            val pending = timeout()!!
            val handler = WebTile::class.java.getDeclaredField("handler")
                .apply { isAccessible = true }.get(tile) as android.os.Handler
            handler.removeCallbacks(pending)
            pending.run()
            assertNotNull(WebTile::class.java.getDeclaredField("networkRetry")
                .apply { isAccessible = true }.get(tile))
        }
    }

    @Test fun lateFailedBrowserCallbacksCannotCancelRetryWatchdog() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = page("assigned")
        }
        val failed = launchTile()
        awaitDocument(failed, "assigned")
        instrumentation.runOnMainSync {
            fun pending(name: String): Runnable? = WebTile::class.java.getDeclaredField(name)
                .apply { isAccessible = true }.get(tile) as Runnable?
            val oldCallbacks = failed.webViewClient
            deliverHttpError(failed, assignedUrl)
            // Execute the retry in this UI turn so no new page callback can race it.
            val retry = pending("networkRetry")!!
            val handler = WebTile::class.java.getDeclaredField("handler")
                .apply { isAccessible = true }.get(tile) as android.os.Handler
            handler.removeCallbacks(retry)
            retry.run()
            val current = findBrowser(tile!!)!!
            assertNotSame(failed, current)
            val watchdog = pending("loadTimeout")!!
            // Same URL: URL comparison alone cannot distinguish these old callbacks.
            oldCallbacks.onPageFinished(failed, assignedUrl)
            oldCallbacks.onPageStarted(failed, assignedUrl, null)
            oldCallbacks.onPageCommitVisible(failed, assignedUrl)
            assertSame("Old callbacks must not cancel the active watchdog", watchdog, pending("loadTimeout"))
            handler.removeCallbacks(watchdog)
            watchdog.run()
            assertNotNull("The unpainted retry still schedules recovery", pending("networkRetry"))
            assertSame(current, findBrowser(tile!!))
        }
    }

    @Test fun invalidAssignedUrlsNeverShowLoadingOrCreateABrowser() {
        instrumentation.runOnMainSync {
            for (url in listOf("", "not-a-url", "https://", "http:///missing-host", "file:///invalid")) {
                assertNull("Invalid origin: $url", WebTile.origin(url))
                val invalid = WebTile(context, JSONObject().put("web", JSONObject().put("url", url))) {}
                try {
                    repeat(2) {
                        val spinner = findSpinner(invalid)!!
                        assertEquals("Invalid URL must not load: $url", View.GONE, spinner.visibility)
                        assertEquals(View.VISIBLE, (spinner.parent as View).visibility)
                        assertNull("Invalid URL must not create a browser: $url", findBrowser(invalid))
                        invalid.reload()
                    }
                } finally { invalid.release() }
            }
        }
    }

    @Test fun initialLoadingRevealsContentOnCommitAndErrorsRetainRecoveryFeedback() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = page("assigned")
        }
        val browser = launchTile()
        awaitDocument(browser, "assigned")
        instrumentation.runOnMainSync {
            val spinner = findSpinner(tile!!)!!
            val overlay = spinner.parent as ViewGroup
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            assertEquals(View.VISIBLE, overlay.visibility)
            assertEquals(View.VISIBLE, spinner.visibility)
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, overlay.layoutParams.height)
            assertFalse("Feedback must not take remote focus", overlay.isFocusable)
            assertFalse("Feedback must not consume touch", overlay.isClickable)
            browser.webViewClient.onPageCommitVisible(browser, assignedUrl)
            assertEquals(View.GONE, spinner.visibility)
            assertEquals("Reveal provider cache progress as soon as its page paints",
                ViewGroup.LayoutParams.WRAP_CONTENT, overlay.layoutParams.height)
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            assertEquals(View.GONE, overlay.visibility)
            deliverHttpError(browser, assignedUrl)
            assertEquals(View.VISIBLE, overlay.visibility)
            assertEquals(View.GONE, spinner.visibility)
            browser.webViewClient.onPageCommitVisible(browser, assignedUrl)
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            assertEquals("An error page must not dismiss retry feedback", View.VISIBLE, overlay.visibility)
        }
    }

    @Test fun startupTimeoutRetriesOnlyBeforeVisibleContentAndReleaseCancelsTimers() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = page("assigned")
        }
        val browser = launchTile()
        awaitDocument(browser, "assigned")
        instrumentation.runOnMainSync {
            fun pending(name: String): Runnable? = WebTile::class.java.getDeclaredField(name)
                .apply { isAccessible = true }.get(tile) as Runnable?
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            pending("loadTimeout")!!.run()
            assertNotNull("A document that never paints must recover", pending("networkRetry"))
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            browser.webViewClient.onPageCommitVisible(browser, assignedUrl)
            pending("loadTimeout")!!.run()
            assertEquals("Do not cover provider content indefinitely", View.GONE,
                (findSpinner(tile!!)!!.parent as View).visibility)
            // Successful completion cancels the failed attempt's retry.
            browser.webViewClient.onPageFinished(browser, assignedUrl)
            assertNull(pending("networkRetry"))
            browser.webViewClient.onPageStarted(browser, assignedUrl, null)
            tile!!.release()
            assertNull(pending("slowLoad"))
            assertNull(pending("loadTimeout"))
        }
    }

    private fun findSpinner(view: View): android.widget.ProgressBar? {
        if (view is android.widget.ProgressBar) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findSpinner(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun deliverHttpError(browser: WebView, target: String) {
        val request = object : WebResourceRequest {
            override fun getUrl(): Uri = Uri.parse(target)
            override fun isForMainFrame() = true
            override fun isRedirect() = false
            override fun hasGesture() = false
            override fun getMethod() = "GET"
            override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
        }
        browser.webViewClient.onReceivedHttpError(browser, request,
            WebResourceResponse("text/html", "UTF-8", 500, "Server error", emptyMap(),
                ByteArrayInputStream(byteArrayOf())))
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
            val web = browser.get()
            val delegate = web.webViewClient
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    delegate.shouldOverrideUrlLoading(view, request)
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    callbacks.offer("start:${Uri.parse(url ?: "").path}")
                    delegate.onPageStarted(view, url, favicon)
                }
                override fun onPageCommitVisible(view: WebView, url: String?) {
                    delegate.onPageCommitVisible(view, url)
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    callbacks.offer("finish:${Uri.parse(url ?: "").path}")
                    delegate.onPageFinished(view, url)
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    callbacks.offer("error:${request.url.path}:main=${request.isForMainFrame}")
                    delegate.onReceivedError(view, request, error)
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                    callbacks.offer("http:${request.url.path}:${error.statusCode}:main=${request.isForMainFrame}")
                    delegate.onReceivedHttpError(view, request, error)
                }
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean =
                    delegate.onRenderProcessGone(view, detail)
            }
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
