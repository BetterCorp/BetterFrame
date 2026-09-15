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
    private var standbyVisible = false
    private var consumeWakeTouch = false
    private val wakeKeys = mutableSetOf<Int>()
    private var previousBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
    private val screenReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
            when (intent.action) {
                android.content.Intent.ACTION_SCREEN_OFF -> suspendDisplay()
                android.content.Intent.ACTION_SCREEN_ON -> {
                    session.setStandby(false)
                    if (started) resumeDisplay()
                }
            }
        }
    }
    private var displayVisible = false
    private var focusedCellId: String? = null
    private val tiles = linkedMapOf<String, Pair<String, ViewerTile>>()
    private val dialogs = mutableSetOf<AlertDialog>()
    private val contentDialogs = mutableSetOf<AlertDialog>()
    private var contentMenuState: ContentMenuState? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session = ViewerSession(this, this)
        if (savedInstanceState?.getBoolean("standby") == true) session.setStandby(true)
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
        runCatching { ManagedKiosk(this).resume() }.onFailure { onStatus("Unable to enter managed kiosk mode") }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        // Returning through the managed Home entry point counts as a local wake.
        if (intent.action == android.content.Intent.ACTION_MAIN) session.setStandby(false)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("standby", session.isStandby)
        super.onSaveInstanceState(outState)
    }

    private fun resumeDisplay() {
        if (active || !(getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive) return
        active = true
        enterFullscreen()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session.start()
        onStandbyChanged(session.isStandby)
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
            contentDescription = getString(R.string.kiosk_menu)
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
            actions += getString(R.string.restore_layout) to { session.expand(null) }
        }
        if ((plan?.optJSONArray("layouts")?.length() ?: 0) > 1) {
            actions += getString(R.string.assigned_layouts) to { chooseLayout() }
        }
        val webTiles = tiles.values.map { it.second }.filterIsInstance<WebTile>()
        if (webTiles.size == 1) {
            val tile = webTiles.single()
            tile.assignedActionLabel?.let { label ->
                if (actions.none { it.first == label }) actions += label to { tile.activateAssignedAction() }
            }
            actions += getString(R.string.reload_web) to { tile.reload() }
        } else if (webTiles.isNotEmpty()) {
            actions += getString(R.string.web_content) to {
                AlertDialog.Builder(this).setTitle(getString(R.string.web_content))
                    .setItems(webTiles.map(::webTileLabel).toTypedArray()) { _, index ->
                        session.recordActivity()
                        showWebMenu(webTiles[index])
                    }.setNegativeButton(getString(R.string.close), null).create().let(::showContentDialog)
            }
        }
        actions += getString(R.string.refresh) to { session.refresh() }
        if (plan?.optString("displayId")?.isNotBlank() == true) actions += getString(R.string.standby) to { session.setStandby(true) }
        actions += getString(R.string.power_and_kiosk) to { showPowerSettings() }
        actions += getString(R.string.settings) to { showSettings() }
        AlertDialog.Builder(this).setTitle("BetterFrame")
            .setItems(actions.map { it.first }.toTypedArray()) { _, index -> session.recordActivity(); actions[index].second() }
            .setNegativeButton(getString(R.string.close), null).create().let(::showContentDialog)
    }

    private fun showWebMenu(tile: WebTile) {
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        tile.assignedActionLabel?.let { actions += it to { tile.activateAssignedAction() } }
        actions += getString(R.string.reload_web) to { tile.reload() }
        AlertDialog.Builder(this).setTitle(webTileLabel(tile))
            .setItems(actions.map { it.first }.toTypedArray()) { _, index -> session.recordActivity(); actions[index].second() }
            .setNegativeButton(getString(R.string.close), null).create().let(::showContentDialog)
    }

    private fun webTileLabel(tile: WebTile): String {
        val position = tile.layoutParams as? CellGrid.Params ?: return tile.contentLabel
        return "${tile.contentLabel} (row ${position.row + 1}, column ${position.col + 1})"
    }

    private fun showDialog(dialog: AlertDialog) {
        dialogs.add(dialog)
        dialog.setOnDismissListener { dialogs.remove(dialog); contentDialogs.remove(dialog) }
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

    private fun showContentDialog(dialog: AlertDialog) {
        contentDialogs.add(dialog)
        showDialog(dialog)
    }

    private fun dismissContentDialogs() { contentDialogs.toList().forEach { it.dismiss() } }

    private fun dismissDialogs() { dialogs.toList().forEach { it.dismiss() } }

    override fun onIdleReturn() = runOnUiThread { dismissDialogs() }

    override fun onStandbyChanged(standby: Boolean) = runOnUiThread {
        if (!active) return@runOnUiThread
        if (standby) {
            if (standbyVisible) return@runOnUiThread
            dismissDialogs()
            (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                .hideSoftInputFromWindow(window.decorView.windowToken, 0)
            releaseTiles()
            standbyVisible = true
            displayVisible = false
            setupView = null
            previousBrightness = window.attributes.screenBrightness
            window.attributes = window.attributes.apply { screenBrightness = 0f }
            root = kioskRoot().apply {
                contentDescription = "BetterFrame standby. Touch or press a remote button to wake."
                isFocusableInTouchMode = true
                setOnClickListener { session.setStandby(false) }
            }
            setContentView(root)
            root.requestFocus()
        } else {
            if (standbyVisible) {
                window.attributes = window.attributes.apply { screenBrightness = previousBrightness }
                standbyVisible = false
            }
            plan?.let { render(it) } ?: showSetup()
        }
    }

    private fun showPowerSettings() {
        val managed = ManagedKiosk(this)
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (managed.isOwner) {
            val wasAllowed = managed.isAllowed
            actions += (if (wasAllowed) getString(R.string.disable_managed_kiosk) else getString(R.string.enable_managed_kiosk)) to {
                runCatching { if (wasAllowed) managed.disable() else managed.enable() }
                    .onSuccess { dismissDialogs(); showPowerSettings() }
                    .onFailure { android.widget.Toast.makeText(this, getString(R.string.managed_kiosk_failed), android.widget.Toast.LENGTH_LONG).show() }
            }
            actions += getString(R.string.screen_off_action) to {
                dismissDialogs()
                runCatching { managed.screenOff() }.onFailure { onStatus(getString(R.string.screen_off_failed)) }
            }
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(8))
            addView(text(getString(R.string.standby_explanation)))
            addView(text(when {
                managed.isOwner -> getString(R.string.managed_explanation)
                managed.isAllowed -> getString(R.string.device_manager_explanation)
                else -> getString(R.string.ordinary_install_explanation)
            }))
            actions.forEach { (label, action) -> addView(button(label, action)) }
        }
        AlertDialog.Builder(this).setTitle(getString(R.string.power_and_kiosk)).setView(content)
            .setNegativeButton(getString(R.string.close), null).create().let(::showDialog)
    }

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
            contentDescription = getString(R.string.server_address)
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(8))
            addView(text(lastStatus))
            addView(text(getString(R.string.server_reset_required)))
            addView(address, LinearLayout.LayoutParams(-1, -2))
        }
        val dialog = AlertDialog.Builder(this).setTitle(getString(R.string.display_settings)).setView(content)
            .setNegativeButton(getString(R.string.close), null).setPositiveButton(getString(R.string.connect), null)
            .setNeutralButton(getString(R.string.reset_enrollment)) { _, _ ->
                confirmReset(session.serverUrl.ifBlank { ServerAddress.DEFAULT })
            }.create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val parsed = runCatching { ServerAddress.parse(address.text.toString()).toString().trimEnd('/') }
                val entered = parsed.getOrNull()
                if (entered == null) {
                    address.error = parsed.exceptionOrNull()?.message ?: getString(R.string.invalid_server_origin)
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
        AlertDialog.Builder(this).setTitle(getString(R.string.reset_display_title))
            .setMessage(getString(R.string.reset_display_message, server))
            .setNegativeButton(getString(R.string.cancel), null)
            .setPositiveButton(getString(R.string.reset_connect)) { _, _ -> resetEnrollment(server) }.create().let(::showDialog)
    }

    private fun resetEnrollment(server: String) {
        session.setStandby(false)
        plan = null
        resetRequested = true
        showSetup("")
        status.text = getString(R.string.clearing_enrollment)
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
        if (session.isStandby) { pairingCode = code; return@runOnUiThread }
        if (displayVisible || setupView == null) showSetup(code)
        else setupView?.showPairing(code)
        pairingCode = code
        if (code.isBlank()) resetRequested = false
    }

    override fun onPlan(value: JSONObject) = runOnUiThread {
        plan = value
        if (active && !session.isStandby) render(value)
    }

    private fun render(value: JSONObject) {
        if (session.isStandby) { onStandbyChanged(true); return }
        if (!displayVisible) showDisplay()
        if (value.has("error")) {
            releaseTiles()
            setupView?.showIdle(value.optString("error", getString(R.string.configuration_unavailable)))
            status.text = lastStatus
            setupView?.visibility = View.VISIBLE
            return
        }
        val cells = value.optJSONArray("cells")
        setupView?.visibility = if (cells == null || cells.length() == 0) View.VISIBLE else View.GONE
        setupView?.showIdle(if (value.optString("layoutId").isBlank())
            getString(R.string.assign_layouts)
            else getString(R.string.empty_layout))
        status.text = lastStatus
        if (cells == null) { releaseTiles(); return }
        val desired = compatibleWebSessions((0 until cells.length()).map { cells.getJSONObject(it) })
        val contentKeys = desired.associate { it.getString("id") to tileContentKey(it) }
        val menuState = ContentMenuState(value.optString("layoutId"), value.optString("expandedCellId"),
            value.optJSONArray("layouts")?.toString().orEmpty(), desired.map { cell ->
                MenuCellState(cell.getString("id"), contentKeys.getValue(cell.getString("id")),
                    cell.optInt("row"), cell.optInt("col"), cell.optInt("rowSpan", 1), cell.optInt("colSpan", 1))
            })
        // Menus capture tile instances and assigned choices. Invalidate them in the
        // same UI transaction before those targets change; identical refreshes stay open.
        if (contentMenuState != menuState) dismissContentDialogs()
        contentMenuState = menuState
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
                else -> status.text = getString(R.string.control_unavailable)
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
                PlaceholderTile(this, cell.optString("label"), getString(R.string.playback_budget))
            } else when (kind) {
                "camera" -> CameraTile(this, cell) { activate(cell) }
                "web" -> WebTile(this, cell, onActivity = session::recordActivity, onActivate = { activate(cell) })
                else -> PlaceholderTile(this, cell.optString("label"), cell.optString("message", getString(R.string.no_content))) { activate(cell) }
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
        AlertDialog.Builder(this).setTitle(getString(R.string.assigned_layouts))
            .setItems(entries.map { it.optString("name", getString(R.string.layout)) }.toTypedArray()) { _, position ->
                session.selectLayout(entries[position].getString("id"))
            }.setNegativeButton(getString(R.string.cancel), null).create().let(::showContentDialog)
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
        if (consumeWakeTouch || standbyVisible || (::session.isInitialized && session.isStandby)) {
            if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
                consumeWakeTouch = true
                session.setStandby(false)
            }
            if (event.actionMasked == android.view.MotionEvent.ACTION_UP || event.actionMasked == android.view.MotionEvent.ACTION_CANCEL) consumeWakeTouch = false
            return true // The waking gesture must never activate the restored content.
        }
        recordTouchActivity(event)
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        if (wakeKeys.contains(event.keyCode) || standbyVisible || (::session.isInitialized && session.isStandby)) {
            if (event.action == android.view.KeyEvent.ACTION_DOWN) {
                wakeKeys.add(event.keyCode)
                session.setStandby(false)
            } else if (event.action == android.view.KeyEvent.ACTION_UP) wakeKeys.remove(event.keyCode)
            return true
        }
        if (::session.isInitialized && event.action == android.view.KeyEvent.ACTION_DOWN) session.recordActivity()
        // Keep the kiosk menu reachable when an interactive WebView owns keyboard focus.
        if (event.keyCode == android.view.KeyEvent.KEYCODE_MENU) {
            if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount == 0) showKioskMenu()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: android.view.MotionEvent): Boolean {
        if (standbyVisible || (::session.isInitialized && session.isStandby)) {
            if (event.actionMasked == android.view.MotionEvent.ACTION_SCROLL || event.actionMasked == android.view.MotionEvent.ACTION_BUTTON_PRESS) session.setStandby(false)
            return true
        }
        recordMotionActivity(event)
        return super.dispatchGenericMotionEvent(event)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (!active) releaseTiles()
    }

    private fun releaseTiles() {
        dismissContentDialogs()
        contentMenuState = null
        tiles.values.forEach { it.second.release() }
        tiles.clear()
        if (::grid.isInitialized) grid.removeAllViews()
    }
}

private data class ContentMenuState(val layoutId: String, val expandedId: String, val layouts: String,
                                    val cells: List<MenuCellState>)
private data class MenuCellState(val id: String, val contentKey: String, val row: Int, val col: Int,
                                val rowSpan: Int, val colSpan: Int)

/** Geometry changes resize existing browser/decoder surfaces without restarting content. */
private fun tileContentKey(cell: JSONObject): String = JSONObject().apply {
    cell.keys().forEach { key ->
        if (key != "row" && key != "col" && key != "rowSpan" && key != "colSpan") put(key, cell.get(key))
    }
}.toString()

/** Resolve shared-origin conflicts before assigning the 32 WebViews and reconciling resources. */
internal fun compatibleWebSessions(cells: List<JSONObject>): List<JSONObject> {
    val sessions = mutableMapOf<String, Map<String, String>>()
    var webCount = 0
    return cells.map { cell ->
        val web = cell.optJSONObject("web")
        if (cell.optString("kind") != "web" || web == null) return@map cell
        val html = web.optString("html")
        // ViewerSession resolves URLs before this guard; HTML has a per-cell synthetic origin.
        val origin = if (!html.isNullOrBlank() && html != "null") null else WebTile.origin(web.optString("url"))
        val storage = web.optJSONObject("localStorage") ?: JSONObject()
        val assigned = storage.keys().asSequence().associateWith { storage.optString(it) }
        val message = when {
            origin != null && sessions[origin]?.let { it != assigned } == true ->
                "Conflicting web session configuration · use a separate display or expand this tile"
            webCount >= 32 -> "Web content limit reached; expand this tile to view"
            else -> null
        }
        if (message == null) {
            webCount++
            if (origin != null) sessions[origin] = assigned
            cell
        } else {
            // Compare before reconciliation so changing eligibility replaces the right resources.
            JSONObject(cell.toString()).put("kind", "placeholder")
                .put("action", JSONObject().put("type", "expand"))
                .put("message", message)
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
