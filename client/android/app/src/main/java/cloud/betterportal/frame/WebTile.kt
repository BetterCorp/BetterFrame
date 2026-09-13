package cloud.betterportal.frame

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.min

/** Assigned browser content never receives a native bridge or the device API key. */
class WebTile(context: Context, cell: JSONObject, private val onActivity: () -> Unit = {},
              private val onActivate: () -> Unit) : ViewerTile(context) {
    private val handler = Handler(Looper.getMainLooper())
    private val content = cell.getJSONObject("web")
    private val html = content.optString("html").takeUnless { it.isBlank() || it == "null" }
    private val url = content.optString("url")
    private val htmlBase = content.optString("baseUrl").takeIf {
        origin(it)?.let { candidate -> Uri.parse(candidate).host?.endsWith(".invalid") == true } == true
    } ?: "https://bf-html.invalid/"
    private val initialOrigin = if (html != null) origin(htmlBase) else origin(url)
    private val storage = content.optJSONObject("localStorage") ?: JSONObject()
    private val interactive = content.optBoolean("interactive", true)
    @Volatile private var browser: WebView? = null
    @Volatile private var released = false
    private var rendererFailures = 0
    private var networkRetries = 0
    private var pageFailed = false
    private var pruneHistoryOnSuccess = false
    private var networkRetry: Runnable? = null
    private var rendererRetry: Runnable? = null
    private val body = android.widget.FrameLayout(context)
    private val status = message("Loading web content…")
    val contentLabel: String = cell.optString("label", "Web content")
    val assignedActionLabel: String? = when (cell.optJSONObject("action")?.optString("type")) {
        "restore" -> "Restore layout"
        "layout.switch" -> "Switch layout"
        "unsupported" -> null
        else -> "Expand content"
    }

    init {
        // Content owns the entire assigned rectangle; native controls live in the kiosk menu.
        addView(body, LayoutParams(-1, -1))
        createBrowser()
    }

    fun activateAssignedAction() { if (!released) onActivate() }

    fun reload() {
        if (released) return
        cancelNetworkRetry()
        cancelRendererRetry()
        rendererFailures = 0
        networkRetries = 0
        browser?.let(::loadAssignedPage) ?: createBrowser()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createBrowser() {
        if (released) return
        cancelNetworkRetry()
        cancelRendererRetry()
        destroyBrowser()
        body.removeAllViews()
        body.addView(status, LayoutParams(-1, -1))
        status.text = "Loading web content…"
        status.visibility = View.VISIBLE
        if (initialOrigin == null) { status.text = "Web content needs an HTTP or HTTPS URL"; return }
        try {
            val web = object : WebView(context) {
                override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? =
                    super.onCreateInputConnection(outAttrs)?.let { connection ->
                        IdleInputConnection.wrap(connection) {
                            if (!released && browser === this) onActivity()
                        }
                    }
            }
            browser = web
            web.setBackgroundColor(Color.BLACK)
            web.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                // Enabled below only when a document-start mute script is available.
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_DEFAULT
                // Keep default offscreen preraster disabled: extra raster tiles consume
                // memory without helping this grid of already visible WebViews.
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
            web.isFocusable = interactive
            web.isFocusableInTouchMode = interactive
            if (!interactive) web.setOnTouchListener { _, _ -> true }
            val documentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            // Assigned signage must start without a gesture. The script mutes HTML media;
            // arbitrary third-party WebAudio is not a platform-enforced mute boundary.
            web.settings.mediaPlaybackRequiresUserGesture = !documentStart
            if (!documentStart && storage.length() > 0) {
                destroyBrowser()
                status.text = "Update Android System WebView to use this signage player"
                return
            }
            // Origin rules apply to document creation; the top-window check excludes child frames.
            val script = """
                (function() {
                  if (window !== window.top || location.origin !== ${JSONObject.quote(initialOrigin)}) return;
                  const assigned = $storage;
                  let previous = [];
                  try { previous = JSON.parse(localStorage.getItem('__bfAssignedKeys') || '[]'); } catch (_) {}
                  if (Array.isArray(previous)) previous.forEach(k => { if (!(k in assigned)) localStorage.removeItem(k); });
                  Object.keys(assigned).forEach(k => localStorage.setItem(k, assigned[k]));
                  localStorage.setItem('__bfAssignedKeys', JSON.stringify(Object.keys(assigned)));
                  function mute(el) { if (el instanceof HTMLMediaElement) { el.defaultMuted = true; el.muted = true; el.volume = 0; } }
                  function scan(root) { mute(root); if (root.querySelectorAll) root.querySelectorAll('video,audio').forEach(mute); }
                  document.addEventListener('volumechange', e => mute(e.target), true);
                  new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(scan))).observe(document, {childList:true, subtree:true});
                  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document), {once:true});
                  else scan(document);
                })();
            """.trimIndent()
            if (documentStart) WebViewCompat.addDocumentStartJavaScript(web, script, setOf(initialOrigin))
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (released || browser !== view) return true
                    if (!request.isForMainFrame) return false
                    val allowed = origin(request.url.toString()) == initialOrigin
                    if (!allowed) { status.text = "Navigation outside the assigned site was blocked"; status.visibility = View.VISIBLE }
                    return !allowed
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    if (released || browser !== view) return
                    pageFailed = false
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (released || browser !== view) return
                    if (!pageFailed) {
                        cancelNetworkRetry()
                        if (pruneHistoryOnSuccess) {
                            // App reload/recovery returns to the assigned document. Keep
                            // that page only; ordinary in-page navigation retains history.
                            pruneHistoryOnSuccess = false
                            view.clearHistory()
                        }
                        status.visibility = View.GONE
                        networkRetries = 0
                    }
                    if (!documentStart && origin(url ?: "") == initialOrigin) view.evaluateJavascript(script, null)
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (!released && browser === view && request.isForMainFrame) failedPage(view)
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                    if (!released && browser === view && request.isForMainFrame && error.statusCode >= 400) failedPage(view)
                }
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (released || browser !== view) return true
                    // Renderer death requires a new WebView, unlike ordinary page errors.
                    cancelNetworkRetry()
                    cancelRendererRetry()
                    destroyBrowser()
                    status.visibility = View.VISIBLE
                    status.text = "Web renderer stopped"
                    rendererFailures++
                    if (rendererFailures <= 3) {
                        rendererRetry = Runnable { rendererRetry = null; createBrowser() }.also {
                            handler.postDelayed(it, 2_000L * rendererFailures)
                        }
                    } else status.text = "Web renderer repeatedly stopped · reload from the kiosk menu"
                    return true
                }
            }
            body.addView(web, 0, LayoutParams(-1, -1))
            loadAssignedPage(web)
        } catch (_: Exception) {
            destroyBrowser()
            status.text = "WebView unavailable · install or update Android System WebView"
            status.visibility = View.VISIBLE
        }
    }

    private fun loadAssignedPage(web: WebView) {
        if (released || browser !== web) return
        cancelNetworkRetry()
        pageFailed = false
        pruneHistoryOnSuccess = true
        status.text = "Loading web content…"
        status.visibility = View.VISIBLE
        try {
            web.stopLoading()
            // Retry the assigned document, never a redirect target or a page in browser history.
            if (html != null) web.loadDataWithBaseURL(htmlBase, html, "text/html", "UTF-8", null)
            else web.loadUrl(url)
        } catch (_: Exception) {
            destroyBrowser()
            status.text = "WebView unavailable · install or update Android System WebView"
        }
    }

    private fun cancelNetworkRetry() {
        networkRetry?.let(handler::removeCallbacks)
        networkRetry = null
    }

    private fun cancelRendererRetry() {
        rendererRetry?.let(handler::removeCallbacks)
        rendererRetry = null
    }

    private fun failedPage(web: WebView) {
        pageFailed = true
        pruneHistoryOnSuccess = false
        status.text = "Web content unavailable · retrying"
        status.visibility = View.VISIBLE
        cancelNetworkRetry()
        networkRetries = min(networkRetries + 1, 6)
        networkRetry = Runnable {
            networkRetry = null
            if (!released && browser === web) loadAssignedPage(web)
        }.also { handler.postDelayed(it, min(60_000L, 1_000L shl networkRetries)) }
    }

    private fun destroyBrowser() {
        val previous = browser ?: return
        browser = null
        body.removeView(previous)
        previous.stopLoading()
        previous.removeAllViews()
        previous.destroy()
    }

    override fun release() {
        released = true
        cancelNetworkRetry()
        cancelRendererRetry()
        destroyBrowser()
    }

    companion object {
        fun origin(url: String): String? = runCatching {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (uri.userInfo != null) return null
            val defaultPort = if (scheme == "https") 443 else 80
            val authorityHost = if (':' in host && !host.startsWith("[")) "[$host]" else host
            "$scheme://$authorityHost" + if (uri.port != -1 && uri.port != defaultPort) ":${uri.port}" else ""
        }.getOrNull()

        fun clearSessions(context: Context, onComplete: (Boolean) -> Unit = {}) {
            // Call on the UI thread after disposing live WebViews. Wait for cookie removal
            // before allowing enrollment again, so it cannot erase a new display session.
            try {
                WebStorage.getInstance().deleteAllData()
                WebView(context).apply { clearCache(true); clearHistory(); destroy() }
                CookieManager.getInstance().removeAllCookies {
                    // The removal callback's Boolean means cookies existed,
                    // not success; an already empty cookie store is also clean.
                    val success = runCatching { CookieManager.getInstance().flush() }.isSuccess
                    onComplete(success)
                }
            } catch (_: Exception) { onComplete(false) }
        }
    }
}
