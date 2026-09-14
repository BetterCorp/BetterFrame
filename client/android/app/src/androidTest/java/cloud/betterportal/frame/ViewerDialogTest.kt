package cloud.betterportal.frame

import android.app.AlertDialog
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@RunWith(AndroidJUnit4::class)
class ViewerDialogTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    @Test fun idleClosesMenusAndSettingsAndDialogInputRenewsTheTimeout() = withViewer { activity, session, clock ->
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MENU)
        await("Kiosk menu opens") { visibleText("Settings") }
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        clock.addAndGet(2_001)
        await("Idle closes menu even on the default layout") { hasWindowFocus(activity) && !visibleText("Settings") }
        instrumentation.uiAutomation.waitForIdle(250, 3000)

        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MENU)
        clickText("Settings")
        await("Settings opens") { visibleText("Display settings") }
        val settings = showingDialog(activity)
        instrumentation.runOnMainSync {
            // This exercises remote input in the dialog. An open IME can consume
            // DPAD navigation before the dialog receives any event or text edit.
            settings.window!!.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            settings.getButton(AlertDialog.BUTTON_NEGATIVE).apply {
                isFocusableInTouchMode = true
                requestFocus()
            }
            (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(settings.window!!.decorView.windowToken, 0)
        }
        await("Settings dialog has input focus") { dialogHasFocus(settings) }
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        clock.addAndGet(1_500)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_DOWN)
        await("Dialog key input reaches the inactivity clock") { lastActivity(session) == clock.get() }
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        clock.addAndGet(1_500)
        Thread.sleep(500)
        // The IME may own the accessibility root after DPAD focuses the editor.
        // Assert the actual dialog window instead of searching that unrelated root.
        assertTrue("Input in a dialog renews inactivity", isShowing(settings))
        // IME selection/composition callbacks can also legitimately renew activity.
        clock.set(lastActivity(session) + 2_001)
        await("Idle dismisses Settings") { !isShowing(settings) && hasWindowFocus(activity) }
        instrumentation.uiAutomation.waitForIdle(250, 3000)

        instrumentation.runOnMainSync { session.expand("10") }
        await("Content expands") { expanded(activity) == "10" }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MENU)
        await("Expanded menu opens") { visibleText("Restore layout") }
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        clock.addAndGet(2_001)
        await("Idle restores content and dismisses the modal together") {
            hasWindowFocus(activity) && expanded(activity) == null && !visibleText("Restore layout") && !visibleText("Settings")
        }
    }

    @Test fun webPickerIdentifiesCurrentTilePositionsAndTargetsTheSelectedPage() = withViewer { activity, _, _ ->
        val current = plan(activity)
        instrumentation.runOnMainSync {
            // Swap geometry while keeping both browser instances alive.
            val moved = JSONObject(current.toString())
            moved.getJSONArray("cells").getJSONObject(0).put("col", 1)
            moved.getJSONArray("cells").getJSONObject(1).put("col", 0)
            activity.onPlan(moved)
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MENU)
        clickText("Web content")
        await("Identical HTML labels include distinct current positions") {
            visibleText("HTML (row 1, column 1)") && visibleText("HTML (row 1, column 2)")
        }
        clickText("HTML (row 1, column 1)")
        await("Submenu identifies the selected tile") { visibleText("HTML (row 1, column 1)") && visibleText("Expand content") }
        clickText("Expand content")
        await("The tile now at column one is expanded") { expanded(activity) == "11" }
    }

    @Test fun contentChangesDismissStaleMenusButKeepSettingsAndUnchangedMenus() = withViewer { activity, session, _ ->
        val original = JSONObject(plan(activity).toString())
        val firstTile = webTile(activity, "10")
        openWebMenu(activity, firstTile)
        val menu = showingDialog(activity)
        instrumentation.runOnMainSync { activity.onPlan(JSONObject(original.toString())) }
        assertTrue("An unchanged refresh leaves the menu usable", isShowing(menu))

        val changed = JSONObject(original.toString()).apply {
            getJSONArray("cells").getJSONObject(0).getJSONObject("web").put("html", "<p>Updated</p>")
        }
        instrumentation.runOnMainSync { activity.onPlan(changed) }
        assertFalse("Replaced content invalidates its captured menu target", isShowing(menu))
        val replacement = webTile(activity, "10")
        assertNotSame(firstTile, replacement)
        openWebMenu(activity, replacement)
        val freshMenu = showingDialog(activity)
        instrumentation.runOnMainSync {
            val list = freshMenu.listView
            val index = (0 until list.adapter.count).single { list.adapter.getItem(it).toString() == "Expand content" }
            list.performItemClick(list.getChildAt(index), index, list.adapter.getItemId(index))
        }
        await("A newly opened menu acts on the current tile") { expanded(activity) == "10" }
        session.expand(null)
        await("Restore both tiles") { expanded(activity) == null && plan(activity)?.getJSONArray("cells")?.length() == 2 }

        val current = JSONObject(plan(activity).toString())
        val beforeMove = webTile(activity, "10")
        openWebMenu(activity, beforeMove)
        val positionedMenu = showingDialog(activity)
        val moved = JSONObject(current.toString()).apply {
            getJSONArray("cells").getJSONObject(0).put("col", 1)
            getJSONArray("cells").getJSONObject(1).put("col", 0)
        }
        instrumentation.runOnMainSync { activity.onPlan(moved) }
        assertFalse("Position labels cannot outlive a geometry change", isShowing(positionedMenu))
        assertSame("Geometry alone still reuses the browser", beforeMove, webTile(activity, "10"))

        invokeActivity(activity, "chooseLayout")
        val layoutMenu = showingDialog(activity)
        val renamed = JSONObject(moved.toString()).apply {
            getJSONArray("layouts").getJSONObject(0).put("name", "Renamed")
        }
        instrumentation.runOnMainSync { activity.onPlan(renamed) }
        assertFalse("Assigned layout choices invalidate their menu", isShowing(layoutMenu))

        invokeActivity(activity, "showSettings")
        val settings = showingDialog(activity)
        instrumentation.runOnMainSync { activity.onPlan(original) }
        assertTrue("Content updates preserve Settings input", isShowing(settings))
        instrumentation.runOnMainSync { settings.dismiss() }
        openWebMenu(activity, webTile(activity, "10"))
        val suspendedMenu = showingDialog(activity)
        invokeActivity(activity, "releaseTiles")
        assertFalse("Releasing playback also releases its menus", isShowing(suspendedMenu))
    }

    private fun withViewer(test: (MainActivity, ViewerSession, AtomicLong) -> Unit) {
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "dialog-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getApplicationContext(): Context = this
        }
        ProtectedStore(isolated).write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "test-key"))
            .put("bundle_profile", "android-viewer-v1").put("bundle", bundle))
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val clock = AtomicLong(1_000)
        lateinit var session: ViewerSession
        try {
            instrumentation.runOnMainSync {
                val field = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
                (field.get(activity) as ViewerSession).close()
                session = ViewerSession(isolated, activity, monotonicTime = clock::get)
                field.set(activity, session)
                session.start()
            }
            await("Cached default layout loads") { hasWindowFocus(activity) && plan(activity)?.optString("layoutId") == "3" }
            instrumentation.uiAutomation.waitForIdle(250, 3000)
            test(activity, session, clock)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            ProtectedStore(context).clear()
            directory.deleteRecursively()
        }
    }

    private fun plan(activity: MainActivity): JSONObject? {
        var result: JSONObject? = null
        instrumentation.runOnMainSync {
            result = MainActivity::class.java.getDeclaredField("plan").apply { isAccessible = true }.get(activity) as? JSONObject
        }
        return result
    }
    private fun expanded(activity: MainActivity) = plan(activity)?.optString("expandedCellId")
        ?.takeUnless { it.isBlank() || it == "null" }
    private fun hasWindowFocus(activity: MainActivity): Boolean {
        var focused = false
        instrumentation.runOnMainSync { focused = activity.hasWindowFocus() }
        return focused
    }
    private fun showingDialog(activity: MainActivity): AlertDialog {
        lateinit var dialog: AlertDialog
        instrumentation.runOnMainSync {
            val dialogs = MainActivity::class.java.getDeclaredField("dialogs").apply { isAccessible = true }
                .get(activity) as Set<*>
            dialog = dialogs.filterIsInstance<AlertDialog>().single { it.isShowing }
        }
        return dialog
    }
    private fun webTile(activity: MainActivity, id: String): WebTile {
        lateinit var tile: WebTile
        instrumentation.runOnMainSync {
            val tiles = MainActivity::class.java.getDeclaredField("tiles").apply { isAccessible = true }.get(activity) as Map<*, *>
            tile = (tiles[id] as Pair<*, *>).second as WebTile
        }
        return tile
    }
    private fun openWebMenu(activity: MainActivity, tile: WebTile) = instrumentation.runOnMainSync {
        MainActivity::class.java.getDeclaredMethod("showWebMenu", WebTile::class.java).apply { isAccessible = true }.invoke(activity, tile)
    }
    private fun invokeActivity(activity: MainActivity, method: String) = instrumentation.runOnMainSync {
        MainActivity::class.java.getDeclaredMethod(method).apply { isAccessible = true }.invoke(activity)
    }
    private fun isShowing(dialog: AlertDialog): Boolean {
        var showing = false
        instrumentation.runOnMainSync { showing = dialog.isShowing }
        return showing
    }
    private fun dialogHasFocus(dialog: AlertDialog): Boolean {
        var focused = false
        instrumentation.runOnMainSync { focused = dialog.window?.decorView?.hasWindowFocus() == true }
        return focused
    }
    private fun lastActivity(session: ViewerSession): Long {
        val lock = ViewerSession::class.java.getDeclaredField("activityLock").apply { isAccessible = true }.get(session)
        return synchronized(lock) {
            ViewerSession::class.java.getDeclaredField("lastActivity").apply { isAccessible = true }.getLong(session)
        }
    }
    private fun nodes(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = buildList {
        add(node)
        for (index in 0 until node.childCount) node.getChild(index)?.let { addAll(nodes(it)) }
    }
    private fun visibleText(value: String) = instrumentation.uiAutomation.rootInActiveWindow?.let(::nodes)
        ?.any { it.isVisibleToUser && it.text?.toString() == value } == true
    private fun await(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) { if (condition()) return; Thread.sleep(50) }
        fail(message)
    }
    private fun clickText(value: String) {
        instrumentation.uiAutomation.waitForIdle(250, 3000)
        await("Visible action: $value") { visibleText(value) }
        val node = nodes(instrumentation.uiAutomation.rootInActiveWindow!!)
            .first { it.isVisibleToUser && it.text?.toString() == value }
        val bounds = Rect().also(node::getBoundsInScreen)
        val downTime = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                bounds.exactCenterX(), bounds.exactCenterY(), 0).apply {
                source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            }
            try { instrumentation.sendPointerSync(event) } finally { event.recycle() }
            if (action == MotionEvent.ACTION_DOWN) Thread.sleep(50)
        }
    }

    private val bundle = """{"kiosk_id":1,"kiosk_name":"Dialog display","version":"1","cameras":[],"displays":[{
      "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":2,"sleep_timeout_seconds":0,"default_layout_id":3,
      "layouts":[{"id":3,"name":"Default","grid_cols":2,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
       "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>One</p>"},
                {"view_id":11,"row":0,"col":1,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Two</p>"}]}]}]}"""
}
