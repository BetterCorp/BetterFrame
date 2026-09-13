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
