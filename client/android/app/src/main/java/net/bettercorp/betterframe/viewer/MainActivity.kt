package net.bettercorp.betterframe.viewer

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.media3.common.util.UnstableApi
import org.json.JSONObject

@UnstableApi
class MainActivity : Activity(), ViewerSession.Listener {
    private lateinit var session: ViewerSession
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var grid: CellGrid
    private lateinit var restore: Button
    private lateinit var layouts: Button
    private var plan: JSONObject? = null
    private var active = false
    private var displayVisible = false
    private var focusedCellId: String? = null
    private val tiles = linkedMapOf<String, Pair<String, ViewerTile>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session = ViewerSession(this, this)
        showSetup()
    }

    override fun onStart() {
        super.onStart()
        active = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        plan?.let { render(it) }
        session.start()
    }

    override fun onStop() {
        active = false
        releaseTiles()
        session.stop()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onStop()
    }

    override fun onDestroy() {
        releaseTiles()
        session.close()
        super.onDestroy()
    }

    private fun text(value: String, size: Float = 16f) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(Color.WHITE)
        setPadding(12, 8, 12, 8)
    }

    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        setOnClickListener { action() }
    }

    private fun showSetup(pairing: String? = null) {
        releaseTiles()
        displayVisible = false
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
            setBackgroundColor(Color.rgb(11, 17, 29))
        }
        root.addView(text("BetterFrame Viewer", 28f))
        root.addView(text("Cameras, webpages and signage for your display"))
        status = text(pairing ?: "Enter your BF server, then approve this display in BF.")
        root.addView(status)
        val address = EditText(this).apply {
            hint = "https://bf.example.com"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(session.serverUrl ?: "")
            contentDescription = "BetterFrame server address"
        }
        root.addView(address, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Connect display") {
            val entered = address.text.toString().trim().trimEnd('/')
            if (WebTile.origin(entered) == null) {
                status.text = "Enter a complete HTTP or HTTPS server address."
            } else {
                status.text = "Connecting…"
                session.start(entered)
            }
        })
        setContentView(root)
    }

    private fun showDisplay() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.rgb(17, 24, 39))
        }
        status = text("BetterFrame")
        status.maxLines = 2
        toolbar.addView(status, LinearLayout.LayoutParams(0, -2, 1f))
        layouts = button("Layouts") { chooseLayout() }
        toolbar.addView(layouts)
        restore = button("Restore") { session.expand(null) }
        toolbar.addView(restore)
        toolbar.addView(button("Refresh") { session.refresh() })
        toolbar.addView(button("Settings") {
            AlertDialog.Builder(this)
                .setTitle("BetterFrame Viewer")
                .setMessage("Server: ${session.serverUrl.orEmpty()}\nUnpair to connect this display to another server.")
                .setNegativeButton("Close", null)
                .setPositiveButton("Unpair") { _, _ ->
                    releaseTiles()
                    plan = null
                    session.unpair()
                    WebTile.clearSessions(this)
                    showSetup()
                }.show()
        })
        root.addView(toolbar, LinearLayout.LayoutParams(-1, -2))
        grid = CellGrid(this)
        root.addView(grid, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        displayVisible = true
    }

    override fun onStatus(message: String) = runOnUiThread { status.text = message }

    override fun onPairing(code: String) = runOnUiThread {
        plan = null
        showSetup(if (code.isBlank()) null else "Pairing code: $code\nApprove this display in BetterFrame.")
    }

    override fun onPlan(value: JSONObject) = runOnUiThread {
        plan = value
        if (active) render(value)
    }

    private fun render(value: JSONObject) {
        if (!displayVisible) showDisplay()
        if (value.has("error")) {
            releaseTiles()
            status.text = value.optString("error", "Display configuration unavailable")
            restore.visibility = View.GONE
            return
        }
        val expanded = value.optString("expandedCellId").takeUnless { it.isBlank() || it == "null" }
        restore.visibility = if (expanded != null) View.VISIBLE else View.GONE
        layouts.visibility = if ((value.optJSONArray("layouts")?.length() ?: 0) > 1) View.VISIBLE else View.GONE
        status.text = value.optString("layoutName", "BetterFrame")
        val cells = value.optJSONArray("cells") ?: return
        val desired = (0 until cells.length()).map { cells.getJSONObject(it) }
        val ids = desired.map { it.getString("id") }.toSet()
        currentFocus?.let { focus ->
            tiles.entries.firstOrNull { (_, entry) -> containsView(entry.second, focus) }?.let { focusedCellId = it.key }
        }
        // Release replaced/hidden resources before allocating a single new decoder or browser.
        tiles.keys.toList().forEach { id ->
            val next = desired.firstOrNull { it.optString("id") == id }
            if (id !in ids || next.toString() != tiles[id]?.first) {
                tiles.remove(id)?.second?.let { it.release(); grid.removeView(it) }
            }
        }
        grid.rows = value.optInt("rows", 1).coerceIn(1, 32)
        grid.cols = value.optInt("cols", 1).coerceIn(1, 32)
        grid.gap = value.optInt("gap", 4).coerceIn(0, 32)
        var cameraCount = 0
        var webCount = 0
        val hasWeb = desired.any { it.optString("kind") == "web" }
        fun activate(cell: JSONObject) {
            val id = cell.getString("id")
            focusedCellId = id
            val action = cell.optJSONObject("action")
            when (action?.optString("type") ?: "expand") {
                "restore" -> session.expand(null)
                "layout.switch" -> action?.optString("layoutId")?.let { session.selectLayout(it) }
                "expand" -> session.expand(if (plan?.optString("expandedCellId") == id) null else id)
                else -> status.text = "This control is unavailable in the Android viewer"
            }
        }
        desired.forEach { cell ->
            val id = cell.getString("id")
            val kind = cell.optString("kind")
            val allowed = when (kind) {
                "camera" -> ++cameraCount <= if (hasWeb) 2 else 4
                "web" -> ++webCount <= 1
                else -> true
            }
            val existing = tiles[id]?.second
            val tile = existing ?: if (!allowed) {
                PlaceholderTile(this, cell.optString("label"), "Layout exceeds this device's playback budget")
            } else when (kind) {
                "camera" -> CameraTile(this, cell) { activate(cell) }
                "web" -> WebTile(this, cell) { focusedCellId = id; session.expand(if (plan?.optString("expandedCellId") == id) null else id) }
                else -> PlaceholderTile(this, cell.optString("label"), cell.optString("message", "No content assigned")) { activate(cell) }
            }
            if (existing == null) {
                tiles[id] = cell.toString() to tile
                grid.addView(tile)
            }
            tile.layoutParams = CellGrid.Params(
                cell.optInt("row", 0), cell.optInt("col", 0),
                cell.optInt("rowSpan", 1), cell.optInt("colSpan", 1)
            )
        }
        grid.requestLayout()
        if (currentFocus?.isShown != true) {
            val target = tiles[focusedCellId]?.second ?: tiles.values.firstOrNull()?.second
            target?.requestFocus(View.FOCUS_DOWN)
        }
    }

    private fun containsView(parent: View, child: View): Boolean {
        var current: android.view.ViewParent? = child.parent
        if (parent === child) return true
        while (current != null) { if (current === parent) return true; current = current.parent }
        return false
    }

    private fun chooseLayout() {
        val assigned = plan?.optJSONArray("layouts") ?: return
        val entries = (0 until assigned.length()).map { assigned.getJSONObject(it) }
        AlertDialog.Builder(this).setTitle("Assigned layouts")
            .setItems(entries.map { it.optString("name", "Layout") }.toTypedArray()) { _, position ->
                session.selectLayout(entries[position].getString("id"))
            }.setNegativeButton("Cancel", null).show()
    }

    @Deprecated("Required for TV and Android versions before predictive back")
    override fun onBackPressed() {
        if (tiles.values.any { it.second.exitInteraction() }) return
        val expanded = plan?.optString("expandedCellId")
        if (!expanded.isNullOrBlank() && expanded != "null") { session.expand(null); return }
        super.onBackPressed()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (!active) releaseTiles()
    }

    private fun releaseTiles() {
        tiles.values.forEach { it.second.release() }
        tiles.clear()
        if (::grid.isInitialized) grid.removeAllViews()
    }
}

/** Absolute grid geometry supports spans without allocating a View per unused grid coordinate. */
private class CellGrid(context: android.content.Context) : ViewGroup(context) {
    var rows = 1
    var cols = 1
    var gap = 4
    class Params(val row: Int, val col: Int, val rowSpan: Int, val colSpan: Int) : LayoutParams(-1, -1)
    override fun generateDefaultLayoutParams(): LayoutParams = Params(0, 0, 1, 1)
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(width, height)
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val bounds = bounds(child.layoutParams as Params, width, height)
            child.measure(MeasureSpec.makeMeasureSpec((bounds[2] - bounds[0]).coerceAtLeast(0), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec((bounds[3] - bounds[1]).coerceAtLeast(0), MeasureSpec.EXACTLY))
        }
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val bounds = bounds(child.layoutParams as Params, right - left, bottom - top)
            child.layout(bounds[0], bounds[1], bounds[2], bounds[3])
        }
    }
    private fun bounds(p: Params, width: Int, height: Int): IntArray {
        val col = p.col.coerceIn(0, cols - 1)
        val row = p.row.coerceIn(0, rows - 1)
        val endCol = (col + p.colSpan.coerceAtLeast(1)).coerceAtMost(cols)
        val endRow = (row + p.rowSpan.coerceAtLeast(1)).coerceAtMost(rows)
        return intArrayOf(width * col / cols + gap / 2, height * row / rows + gap / 2,
            width * endCol / cols - gap / 2, height * endRow / rows - gap / 2)
    }
}
