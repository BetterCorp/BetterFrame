package cloud.betterportal.frame

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** A tile owns its decoders/browser and releases them synchronously before replacement. */
abstract class ViewerTile(context: Context) : FrameLayout(context) {
    private var overlay: android.webkit.WebView? = null
    private var overlayHtml: String? = null

    fun updateOverlay(html: String?) {
        val next = html?.takeUnless { it.isBlank() || it == "null" }
        if (next == overlayHtml) { overlay?.bringToFront(); return }
        overlayHtml = next
        if (next == null) { releaseOverlay(); return }
        val web = overlay ?: object : android.webkit.WebView(context) {
            override fun onTouchEvent(event: android.view.MotionEvent?) = false
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
            isFocusable = false
            isClickable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            settings.javaScriptEnabled = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldOverrideUrlLoading(view: android.webkit.WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                    val url = request?.url?.toString()
                    return url != "about:blank" && url != "about:srcdoc"
                }
            }
            this@ViewerTile.overlay = this
            this@ViewerTile.addView(this, FrameLayout.LayoutParams(-1, -1))
        }
        web.loadDataWithBaseURL("https://bf-overlay.invalid/", next, "text/html", "UTF-8", null)
        web.bringToFront()
    }

    fun releaseOverlay() {
        overlay?.let { removeView(it); it.stopLoading(); it.destroy() }
        overlay = null
        overlayHtml = null
    }

    abstract fun release()
    protected fun message(text: String): TextView = TextView(context).apply {
        this.text = text
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.BLACK)
        textSize = 16f
        gravity = Gravity.CENTER
        setPadding(20, 20, 20, 20)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    protected fun focusBorder(view: View) {
        fun border(color: Int) = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke((3 * resources.displayMetrics.density).toInt(), color)
        }
        view.background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), border(Color.rgb(56, 189, 248)))
            addState(intArrayOf(), border(Color.TRANSPARENT))
        }
    }
}

class PlaceholderTile(context: Context, label: String, reason: String, onActivate: (() -> Unit)? = null) : ViewerTile(context) {
    init {
        setBackgroundColor(Color.BLACK)
        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        val logo = ImageView(context).apply {
            contentDescription = "BetterFrame"
            setImageResource(R.drawable.betterframe_wordmark)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        content.addView(logo, LinearLayout.LayoutParams(-1, 0, 1f).apply {
            topMargin = (16 * resources.displayMetrics.density).toInt()
            marginStart = topMargin; marginEnd = topMargin
        })
        content.addView(message(if (label.isBlank()) reason else "$label\n$reason"),
            LinearLayout.LayoutParams(-1, 0, 1f))
        addView(content, LayoutParams(-1, -1))
        isFocusable = true
        if (onActivate != null) setOnClickListener { onActivate() }
        foreground = GradientDrawable().apply { setStroke(2, Color.DKGRAY); setColor(Color.TRANSPARENT) }
        focusBorder(this)
    }
    override fun release() = Unit
}
