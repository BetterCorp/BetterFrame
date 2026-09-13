package cloud.betterportal.frame

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
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.media3.common.util.UnstableApi
import org.json.JSONObject

@UnstableApi
class MainActivity : Activity(), ViewerSession.Listener {
    private lateinit var session: ViewerSession
    private lateinit var root: FrameLayout
    private lateinit var status: TextView
    private var setupView: KioskSetupView? = null
    private var pairingCode = ""
    private var lastStatus = "Connecting to BetterFrame…"
    private var resetRequested = false
    private lateinit var grid: CellGrid
    private var plan: JSONObject? = null
    private var active = false
    private var started = false
    private val screenReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
            when (intent.action) {
                android.content.Intent.ACTION_SCREEN_OFF -> suspendDisplay()
                android.content.Intent.ACTION_SCREEN_ON -> if (started) resumeDisplay()
            }
        }
    }
    private var displayVisible = false
    private var focusedCellId: String? = null
    private val tiles = linkedMapOf<String, Pair<String, ViewerTile>>()
    private val dialogs = mutableSetOf<AlertDialog>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session = ViewerSession(this, this)
        showSetup()
        val filter = android.content.IntentFilter().apply {
            addAction(android.content.Intent.ACTION_SCREEN_OFF)
            addAction(android.content.Intent.ACTION_SCREEN_ON)
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, android.content.Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, filter)
    }

    override fun onStart() {
        super.onStart()
        started = true
        resumeDisplay()
    }

    private fun resumeDisplay() {
        if (active || !(getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive) return
        active = true
        enterFullscreen()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        plan?.let { render(it) }
        session.start()
    }

    @Suppress("DEPRECATION")
    private fun enterFullscreen() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.apply {
                systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(android.view.WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && started) enterFullscreen()
    }

    private fun suspendDisplay() {
        active = false
        releaseTiles()
        session.stop()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onStop() {
        started = false
        suspendDisplay()
        super.onStop()
    }

    override fun onDestroy() {
        unregisterReceiver(screenReceiver)
        dismissDialogs()
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

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun kioskRoot() = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

    private fun addMenu() {
        val menu = button("⋮") { showKioskMenu() }.apply {
            contentDescription = "Kiosk menu"
            textSize = 24f
            setTextColor(android.content.res.ColorStateList(
                arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()),
                intArrayOf(Color.rgb(56, 189, 248), Color.rgb(148, 163, 184))))
            background = android.graphics.drawable.StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused),
                    android.graphics.drawable.GradientDrawable().apply {
                        setColor(Color.rgb(17, 24, 39)); setStroke(dp(2), Color.rgb(56, 189, 248))
                    })
                addState(intArrayOf(), android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            }
            setPadding(0, 0, 0, 0)
        }
        root.addView(menu, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.BOTTOM or Gravity.END).apply {
            marginEnd = dp(8); bottomMargin = dp(8)
        })
    }

    private fun showSetup(code: String = pairingCode) {
        releaseTiles()
        displayVisible = false
        root = kioskRoot()
        val setup = KioskSetupView(this)
        setupView = setup
        status = setup.status
        setup.showPairing(code)
        setup.updateDetails(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
        root.addView(setup, FrameLayout.LayoutParams(-1, -1))
        addMenu()
        setContentView(root)
    }

    private fun showKioskMenu() {
        if (resetRequested) return
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        val expanded = plan?.optString("expandedCellId")
        if (!expanded.isNullOrBlank() && expanded != "null") {
            actions += "Restore layout" to { session.expand(null) }
        }
        if ((plan?.optJSONArray("layouts")?.length() ?: 0) > 1) {
            actions += "Assigned layouts" to { chooseLayout() }
        }
        val webTiles = tiles.values.map { it.second }.filterIsInstance<WebTile>()
        if (webTiles.size == 1) {
            val tile = webTiles.single()
            tile.assignedActionLabel?.let { label ->
                if (actions.none { it.first == label }) actions += label to { tile.activateAssignedAction() }
            }
            actions += "Reload web content" to { tile.reload() }
        } else if (webTiles.isNotEmpty()) {
            actions += "Web content" to {
                AlertDialog.Builder(this).setTitle("Web content")
                    .setItems(webTiles.map(::webTileLabel).toTypedArray()) { _, index ->
                        session.recordActivity()
                        showWebMenu(webTiles[index])
                    }.setNegativeButton("Close", null).create().let(::showDialog)
            }
        }
        actions += "Refresh" to { session.refresh() }
        actions += "Settings" to { showSettings() }
        AlertDialog.Builder(this).setTitle("BetterFrame")
            .setItems(actions.map { it.first }.toTypedArray()) { _, index -> session.recordActivity(); actions[index].second() }
            .setNegativeButton("Close", null).create().let(::showDialog)
    }

    private fun showWebMenu(tile: WebTile) {
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        tile.assignedActionLabel?.let { actions += it to { tile.activateAssignedAction() } }
        actions += "Reload web content" to { tile.reload() }
        AlertDialog.Builder(this).setTitle(webTileLabel(tile))
            .setItems(actions.map { it.first }.toTypedArray()) { _, index -> session.recordActivity(); actions[index].second() }
            .setNegativeButton("Close", null).create().let(::showDialog)
    }

    private fun webTileLabel(tile: WebTile): String {
        val position = tile.layoutParams as? CellGrid.Params ?: return tile.contentLabel
        return "${tile.contentLabel} (row ${position.row + 1}, column ${position.col + 1})"
    }

    private fun showDialog(dialog: AlertDialog) {
        dialogs.add(dialog)
        dialog.setOnDismissListener { dialogs.remove(dialog) }
        dialog.show()
        val window = dialog.window ?: return
        val callback = window.callback ?: return
        // Dialogs have their own windows, so Activity dispatch never sees their input.
        window.callback = object : android.view.Window.Callback by callback {
            override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
                recordTouchActivity(event)
                return callback.dispatchTouchEvent(event)
            }
            override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
                if (event.action == android.view.KeyEvent.ACTION_DOWN) session.recordActivity()
                return callback.dispatchKeyEvent(event)
            }
            override fun dispatchGenericMotionEvent(event: android.view.MotionEvent): Boolean {
                recordMotionActivity(event)
                return callback.dispatchGenericMotionEvent(event)
            }
        }
    }

    private fun dismissDialogs() { dialogs.toList().forEach { it.dismiss() } }

    override fun onIdleReturn() = runOnUiThread { dismissDialogs() }

    private fun showSettings() {
        val address = object : EditText(this) {
            override fun onCreateInputConnection(outAttrs: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection? =
                super.onCreateInputConnection(outAttrs)?.let { connection ->
                    IdleInputConnection.wrap(connection) { if (isAttachedToWindow) session.recordActivity() }
                }
        }.apply {
            hint = ServerAddress.DEFAULT
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
            contentDescription = "BetterFrame server address"
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(8))
            addView(text(lastStatus))
            addView(text("Server changes after enrollment require a reset."))
            addView(address, LinearLayout.LayoutParams(-1, -2))
        }
        val dialog = AlertDialog.Builder(this).setTitle("Display settings").setView(content)
            .setNegativeButton("Close", null).setPositiveButton("Connect", null)
            .setNeutralButton("Reset enrollment") { _, _ ->
                confirmReset(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
            }.create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val parsed = runCatching { ServerAddress.parse(address.text.toString()).toString().trimEnd('/') }
                val entered = parsed.getOrNull()
                if (entered == null) {
                    address.error = parsed.exceptionOrNull()?.message ?: "Enter a valid BF server origin."
                } else {
                    dialog.dismiss()
                    if (entered != session.serverUrl.trimEnd('/')) confirmReset(entered)
                    else session.start(entered)
                }
            }
        }
        showDialog(dialog)
    }

    private fun confirmReset(server: String) {
        AlertDialog.Builder(this).setTitle("Reset this display?")
            .setMessage("Remove this display's saved enrollment, cached configuration and web sessions, then pair with $server?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Reset and connect") { _, _ -> resetEnrollment(server) }.create().let(::showDialog)
    }

    private fun resetEnrollment(server: String) {
        plan = null
        resetRequested = true
        showSetup("")
        status.text = "Clearing enrollment…"
        // Queue the restart in the session, which waits for durable/browser cleanup.
        // Connection-status callbacks must not decide whether this reset reconnects.
        session.unpair(server)
        if (active) session.start(server)
    }

    private fun showDisplay() {
        root = kioskRoot()
        grid = CellGrid(this).apply { tag = "display-grid" }
        root.addView(grid, FrameLayout.LayoutParams(-1, -1))
        val idle = KioskSetupView(this).apply {
            visibility = View.GONE
            updateDetails(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
        }
        setupView = idle
        status = idle.status
        root.addView(idle, FrameLayout.LayoutParams(-1, -1))
        addMenu()
        setContentView(root)
        displayVisible = true
    }

    override fun onStatus(message: String) = runOnUiThread {
        // A reset failure is reported here; leave Settings usable for recovery.
        resetRequested = false
        lastStatus = message
        status.text = message
        // The pairing code has its own view and survives connection/status updates.
        setupView?.updateDetails(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
    }

    override fun onServerAddress(address: String) = runOnUiThread { setupView?.updateDetails(address) }

    override fun onPairing(code: String) = runOnUiThread {
        plan = null
        if (displayVisible || setupView == null) showSetup(code)
        else setupView?.showPairing(code)
        pairingCode = code
        if (code.isBlank()) resetRequested = false
    }

    override fun onPlan(value: JSONObject) = runOnUiThread {
        plan = value
        if (active) render(value)
    }

    private fun render(value: JSONObject) {
        if (!displayVisible) showDisplay()
        if (value.has("error")) {
            releaseTiles()
            setupView?.showIdle(value.optString("error", "Display configuration unavailable"))
            status.text = lastStatus
            setupView?.visibility = View.VISIBLE
            return
        }
        val cells = value.optJSONArray("cells")
        setupView?.visibility = if (cells == null || cells.length() == 0) View.VISIBLE else View.GONE
        setupView?.showIdle(if (value.optString("layoutId").isBlank())
            "go into BetterFrame and assign layouts to this display"
            else "This layout is empty. Add content to it in BetterFrame.")
        status.text = lastStatus
        if (cells == null) { releaseTiles(); return }
        val desired = compatibleWebSessions((0 until cells.length()).map { cells.getJSONObject(it) })
        val contentKeys = desired.associate { it.getString("id") to tileContentKey(it) }
        currentFocus?.let { focus ->
            tiles.entries.firstOrNull { (_, entry) -> containsView(entry.second, focus) }?.let { focusedCellId = it.key }
        }
        // Release replaced/hidden resources before allocating a single new decoder or browser.
        tiles.keys.toList().forEach { id ->
            if (contentKeys[id] != tiles[id]?.first) {
                tiles.remove(id)?.second?.let { it.release(); grid.removeView(it) }
            }
        }
        grid.rows = value.optInt("rows", 1).coerceIn(1, 32)
        grid.cols = value.optInt("cols", 1).coerceIn(1, 32)
        grid.gap = value.optInt("gap", 4).coerceIn(0, 32)
        var cameraCount = 0
        var webCount = 0
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
                "camera" -> ++cameraCount <= 32
                "web" -> ++webCount <= 32
                else -> true
            }
            val existing = tiles[id]?.second
            val tile = existing ?: if (!allowed) {
                PlaceholderTile(this, cell.optString("label"), "Layout exceeds this device's playback budget")
            } else when (kind) {
                "camera" -> CameraTile(this, cell) { activate(cell) }
                "web" -> WebTile(this, cell, onActivity = session::recordActivity, onActivate = { activate(cell) })
                else -> PlaceholderTile(this, cell.optString("label"), cell.optString("message", "No content assigned")) { activate(cell) }
            }
            if (existing == null) {
                tiles[id] = contentKeys.getValue(id) to tile
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
            }.setNegativeButton("Cancel", null).create().let(::showDialog)
    }

    @Deprecated("Required for TV and Android versions before predictive back")
    override fun onBackPressed() {
        val expanded = plan?.optString("expandedCellId")
        if (!expanded.isNullOrBlank() && expanded != "null") { session.expand(null); return }
        showKioskMenu()
    }

    private fun recordTouchActivity(event: android.view.MotionEvent) {
        if (::session.isInitialized && (event.actionMasked == android.view.MotionEvent.ACTION_DOWN ||
                event.actionMasked == android.view.MotionEvent.ACTION_MOVE ||
                event.actionMasked == android.view.MotionEvent.ACTION_UP)) session.recordActivity()
    }

    private fun recordMotionActivity(event: android.view.MotionEvent) {
        if (::session.isInitialized && (event.actionMasked == android.view.MotionEvent.ACTION_SCROLL ||
                event.actionMasked == android.view.MotionEvent.ACTION_HOVER_MOVE)) session.recordActivity()
    }

    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        recordTouchActivity(event)
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        if (::session.isInitialized && event.action == android.view.KeyEvent.ACTION_DOWN) session.recordActivity()
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: android.view.MotionEvent): Boolean {
        recordMotionActivity(event)
        return super.dispatchGenericMotionEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_MENU) {
            if (event.repeatCount == 0) showKioskMenu()
            return true
        }
        return super.onKeyDown(keyCode, event)
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

/** Geometry changes resize existing browser/decoder surfaces without restarting content. */
private fun tileContentKey(cell: JSONObject): String = JSONObject().apply {
    cell.keys().forEach { key ->
        if (key != "row" && key != "col" && key != "rowSpan" && key != "colSpan") put(key, cell.get(key))
    }
}.toString()

/** All URLs are resolved by ViewerSession before this guard. WebViews share origin storage. */
internal fun compatibleWebSessions(cells: List<JSONObject>): List<JSONObject> {
    val sessions = mutableMapOf<String, Map<String, String>>()
    return cells.map { cell ->
        val web = cell.optJSONObject("web")
        val html = web?.optString("html")
        if (cell.optString("kind") != "web" || web == null || (!html.isNullOrBlank() && html != "null")) {
            cell // HTML has a per-cell synthetic origin.
        } else {
            val origin = WebTile.origin(web.optString("url"))
            val storage = web.optJSONObject("localStorage") ?: JSONObject()
            val assigned = storage.keys().asSequence().associateWith { storage.optString(it) }
            if (origin == null || sessions[origin]?.let { it == assigned } != false) {
                if (origin != null) sessions[origin] = assigned
                cell
            } else {
                // Compare before reconciliation so changed conflicts replace existing browsers.
                JSONObject(cell.toString()).put("kind", "placeholder")
                    .put("action", JSONObject().put("type", "expand"))
                    .put("message", "Conflicting web session configuration · use a separate display or expand this tile")
            }
        }
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
