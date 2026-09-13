package net.bettercorp.betterframe.viewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
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
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.min

/** Assigned browser content never receives a native bridge or the device API key. */
class WebTile(context: Context, cell: JSONObject, onExpand: () -> Unit) : ViewerTile(context) {
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
    private var browser: WebView? = null
    private var released = false
    private var rendererFailures = 0
    private var networkRetries = 0
    private var interacting = false
    private var pageFailed = false
    private val body = android.widget.FrameLayout(context)
    private val status = message("Loading web content…")
    private val interactButton = Button(context).apply {
        text = "Interact"
        contentDescription = "Interact with ${cell.optString("label", "web content")}"
        visibility = if (interactive) View.VISIBLE else View.GONE
        setOnClickListener {
            if (interacting) exitInteraction() else {
                interacting = true
                text = "Exit page"
                browser?.apply { isFocusable = true; isFocusableInTouchMode = true; requestFocus() }
            }
        }
    }

    init {
        val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        addView(column, LayoutParams(-1, -1))
        val toolbar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.rgb(17, 24, 39))
        }
        toolbar.addView(TextView(context).apply {
            text = cell.optString("label", "Web content")
            setTextColor(Color.WHITE)
            setPadding(12, 0, 4, 0)
            maxLines = 1
        }, LinearLayout.LayoutParams(0, -2, 1f))
        toolbar.addView(interactButton)
        toolbar.addView(Button(context).apply { text = "Expand"; setOnClickListener { onExpand() } })
        toolbar.addView(Button(context).apply {
            text = "Reload"
            setOnClickListener { rendererFailures = 0; networkRetries = 0; createBrowser() }
        })
        column.addView(toolbar, LinearLayout.LayoutParams(-1, -2))
        column.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))
        createBrowser()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createBrowser() {
        if (released) return
        handler.removeCallbacksAndMessages(null)
        destroyBrowser()
        body.removeAllViews()
        body.addView(status, LayoutParams(-1, -1))
        status.text = "Loading web content…"
        status.visibility = View.VISIBLE
        if (initialOrigin == null) { status.text = "Web content needs an HTTP or HTTPS URL"; return }
        try {
            val web = WebView(context)
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
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
            web.isFocusable = false
            web.isFocusableInTouchMode = false
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
                  document.addEventListener('DOMContentLoaded', () => scan(document));
                })();
            """.trimIndent()
            if (documentStart) WebViewCompat.addDocumentStartJavaScript(web, script, setOf(initialOrigin))
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    val allowed = origin(request.url.toString()) == initialOrigin
                    if (!allowed) { status.text = "Navigation outside the assigned site was blocked"; status.visibility = View.VISIBLE }
                    return !allowed
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    pageFailed = false
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (!pageFailed) {
                        status.visibility = View.GONE
                        networkRetries = 0
                    }
                    if (!documentStart && origin(url ?: "") == initialOrigin) view.evaluateJavascript(script, null)
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) failedPage()
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                    if (request.isForMainFrame && error.statusCode >= 400) failedPage()
                }
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    // Remove and destroy every affected tile through its own callback; no stale WebView reuse.
                    destroyBrowser()
                    status.visibility = View.VISIBLE
                    status.text = "Web renderer stopped"
                    rendererFailures++
                    if (rendererFailures <= 3) handler.postDelayed({ createBrowser() }, 2_000L * rendererFailures)
                    else status.text = "Web renderer repeatedly stopped · select Reload"
                    return true
                }
            }
            body.addView(web, 0, LayoutParams(-1, -1))
            if (html != null) {
                // A synthetic origin prevents HTML from inheriting the authenticated BF origin.
                web.loadDataWithBaseURL(htmlBase, html, "text/html", "UTF-8", null)
            } else web.loadUrl(url)
        } catch (_: Exception) {
            destroyBrowser()
            status.text = "WebView unavailable · install or update Android System WebView"
            status.visibility = View.VISIBLE
        }
    }

    private fun failedPage() {
        pageFailed = true
        status.text = "Web content unavailable · retrying"
        status.visibility = View.VISIBLE
        handler.removeCallbacksAndMessages(null)
        networkRetries = min(networkRetries + 1, 6)
        handler.postDelayed({ createBrowser() }, min(60_000L, 1_000L shl networkRetries))
    }

    override fun exitInteraction(): Boolean {
        if (!interacting && browser?.hasFocus() != true) return false
        interacting = false
        browser?.apply { clearFocus(); isFocusable = false; isFocusableInTouchMode = false }
        interactButton.text = "Interact"
        interactButton.requestFocus()
        return true
    }

    private fun destroyBrowser() {
        val previous = browser ?: return
        browser = null
        body.removeView(previous)
        previous.stopLoading()
        previous.removeAllViews()
        previous.destroy()
        interacting = false
        interactButton.text = "Interact"
    }

    override fun release() {
        released = true
        handler.removeCallbacksAndMessages(null)
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

        fun clearSessions(context: Context, onComplete: () -> Unit = {}) {
            // Call on the UI thread after disposing live WebViews. Wait for cookie removal
            // before allowing enrollment again, so it cannot erase a new display session.
            try {
                WebStorage.getInstance().deleteAllData()
                WebView(context).apply { clearCache(true); clearHistory(); destroy() }
                CookieManager.getInstance().removeAllCookies {
                    CookieManager.getInstance().flush()
                    onComplete()
                }
            } catch (_: Exception) { onComplete() }
        }
    }
}
