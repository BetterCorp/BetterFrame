package cloud.betterportal.frame

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView

/** A tile owns its decoders/browser and releases them synchronously before replacement. */
abstract class ViewerTile(context: Context) : FrameLayout(context) {
    abstract fun release()
    open fun exitInteraction(): Boolean = false
    protected fun message(text: String): TextView = TextView(context).apply {
        this.text = text
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.rgb(17, 24, 39))
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
        addView(message(if (label.isBlank()) reason else "$label\n$reason"), LayoutParams(-1, -1))
        isFocusable = true
        if (onActivate != null) setOnClickListener { onActivate() }
        foreground = GradientDrawable().apply { setStroke(2, Color.DKGRAY); setColor(Color.TRANSPARENT) }
        focusBorder(this)
    }
    override fun release() = Unit
}
