package cloud.betterportal.frame

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.os.Build
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** The same quiet, branded pairing/idle surface as the desktop kiosk. */
internal class KioskSetupView(context: Context) : LinearLayout(context) {
    private val compact = resources.configuration.screenHeightDp < 450
    private val muted = Color.rgb(148, 163, 184)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun label(size: Float, color: Int = Color.WHITE) = TextView(context).apply {
        textSize = size
        setTextColor(color)
        gravity = Gravity.CENTER
    }

    private val heading = label(14f, muted)
    private val code = label(if (compact) 64f else 88f).apply {
        tag = "pairing-code"
        typeface = Typeface.create("monospace", Typeface.BOLD)
        letterSpacing = 0.12f
        setSingleLine()
        // Single-line mode enables scrolling, which makes autosizing ignore width.
        setHorizontallyScrolling(false)
        setAutoSizeTextTypeUniformWithConfiguration(28, if (compact) 64 else 88, 1,
            android.util.TypedValue.COMPLEX_UNIT_SP)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    private val instructions = label(16f, muted)
    val status = label(14f, muted).apply {
        tag = "connection-status"
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val details = label(11f, muted).apply {
        tag = "kiosk-details"
        gravity = Gravity.START
        typeface = Typeface.MONOSPACE
        setPadding(dp(20), dp(8), dp(68), dp(12))
    }

    init {
        tag = "kiosk-setup"
        orientation = VERTICAL
        setBackgroundColor(Color.BLACK)
        val content = LinearLayout(context).apply {
            orientation = VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(if (compact) 12 else 32), dp(24), dp(12))
        }
        val logo = ImageView(context).apply {
            contentDescription = "BetterFrame"
            setImageResource(R.drawable.betterframe_wordmark)
            scaleType = ImageView.ScaleType.FIT_CENTER
            adjustViewBounds = true
            maxWidth = dp(480)
        }
        content.addView(logo, LayoutParams(LayoutParams.MATCH_PARENT, dp(if (compact) 64 else 118)))
        fun addLabel(view: View, height: Int = LayoutParams.WRAP_CONTENT, margin: Int = 12) {
            content.addView(view, LayoutParams(LayoutParams.MATCH_PARENT, height).apply {
                topMargin = dp(if (compact) margin / 2 else margin)
            })
        }
        addLabel(heading, margin = 24)
        addLabel(code, dp(if (compact) 84 else 112), 4)
        addLabel(instructions)
        addLabel(status)
        val scroll = ScrollView(context).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        }
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(details, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        showPairing("")
    }

    fun showPairing(value: String) {
        val pairing = value.isNotBlank()
        heading.text = if (pairing) context.getString(R.string.pair_display) else ""
        heading.visibility = if (pairing) View.VISIBLE else View.GONE
        code.text = value
        code.contentDescription = context.getString(R.string.pairing_code, value.toCharArray().joinToString(" "))
        code.visibility = if (pairing) View.VISIBLE else View.GONE
        instructions.text = context.getString(R.string.pairing_instructions)
        instructions.visibility = if (pairing) View.VISIBLE else View.GONE
        status.text = if (pairing) context.getString(R.string.waiting_approval) else context.getString(R.string.connecting_betterframe)
    }

    fun showIdle(message: String) {
        heading.visibility = View.GONE
        code.visibility = View.GONE
        instructions.text = message
        instructions.visibility = View.VISIBLE
    }

    fun updateDetails(server: String) {
        val network = runCatching {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            manager.getLinkProperties(manager.activeNetwork)?.linkAddresses
                ?.map { it.address }?.firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
                ?.hostAddress
        }.getOrNull() ?: context.getString(R.string.not_connected)
        details.text = "Server: $server\nIP: $network\nFW: ${BuildConfig.VERSION_NAME}  •  Android ${Build.VERSION.RELEASE}  •  ${Build.MODEL}"
    }
}
