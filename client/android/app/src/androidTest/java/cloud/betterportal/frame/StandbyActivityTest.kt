package cloud.betterportal.frame

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class StandbyActivityTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    @Test fun standbyReleasesBrowsersAndWakeUsesTheLatestPlanWithoutActivatingIt() = withViewer { activity, session ->
        session.setStandby(true)
        await("Standby surface replaces media") { standby(activity) && browsers(activity) == 0 }
        instrumentation.runOnMainSync {
            val root = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
            assertEquals(Color.BLACK, (root.background as ColorDrawable).color)
            assertEquals(0f, activity.window.attributes.screenBrightness, 0f)
        }
        val updated = JSONObject(plan(activity).toString()).apply {
            getJSONArray("cells").getJSONObject(0).getJSONObject("web").put("html", "<p>Updated while asleep</p>")
        }
        instrumentation.runOnMainSync { activity.onPlan(updated) }
        assertEquals("Bundle updates cannot recreate sleeping browsers", 0, browsers(activity))
        val downTime = SystemClock.uptimeMillis()
        instrumentation.runOnMainSync {
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 100f, 100f, 0)
                    .apply { source = InputDevice.SOURCE_TOUCHSCREEN }
                try { assertTrue(activity.dispatchTouchEvent(event)) } finally { event.recycle() }
            }
        }
        await("Touch wakes the current content") { !session.isStandby && !standby(activity) && browsers(activity) == 1 }
        assertTrue(plan(activity).toString().contains("Updated while asleep"))
        assertTrue("Wake does not expand content", plan(activity)!!.isNull("expandedCellId"))
        instrumentation.runOnMainSync { assertEquals(-1f, activity.window.attributes.screenBrightness, 0f) }
    }

    @Test fun firstMenuKeyOnlyWakesAndRemoteWakeRecreatesPlayback() = withViewer { activity, session ->
        session.setStandby(true)
        await("Standby is shown") { standby(activity) }
        instrumentation.runOnMainSync {
            activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MENU))
            activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MENU))
        }
        await("Remote key wakes") { !standby(activity) && browsers(activity) == 1 }
        instrumentation.runOnMainSync {
            val dialogs = MainActivity::class.java.getDeclaredField("dialogs").apply { isAccessible = true }.get(activity) as Set<*>
            assertTrue("The waking MENU key cannot also open a dialog", dialogs.isEmpty())
        }
        session.setStandby(true)
        await("Sleep again") { standby(activity) && browsers(activity) == 0 }
        session.setStandby(false)
        await("Server/API wake restores playback") { !standby(activity) && browsers(activity) == 1 }
        instrumentation.runOnMainSync {
            val managed = ManagedKiosk(activity)
            assertFalse("Ordinary installs are not device owners", managed.isOwner)
            assertFalse("Ordinary installs cannot silently enable managed mode", runCatching { managed.enable() }.isSuccess)
            assertFalse("Ordinary installs cannot lock the device", runCatching { managed.screenOff() }.isSuccess)
        }
    }

    private fun withViewer(test: (MainActivity, ViewerSession) -> Unit) {
        val context = instrumentation.targetContext
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9")
            .put("resolved_server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "test-key"))
            .put("bundle_profile", "android-viewer-v1").put("bundle", bundle))
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        lateinit var session: ViewerSession
        try {
            instrumentation.runOnMainSync {
                session = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }.get(activity) as ViewerSession
            }
            await("Cached content renders") { browsers(activity) == 1 }
            test(activity, session)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            ProtectedStore(context).clear()
        }
    }
    private fun standby(activity: MainActivity): Boolean {
        var result = false
        instrumentation.runOnMainSync {
            result = MainActivity::class.java.getDeclaredField("standbyVisible").apply { isAccessible = true }.getBoolean(activity)
        }
        return result
    }
    private fun plan(activity: MainActivity): JSONObject? {
        var result: JSONObject? = null
        instrumentation.runOnMainSync {
            result = MainActivity::class.java.getDeclaredField("plan").apply { isAccessible = true }.get(activity) as? JSONObject
        }
        return result
    }
    private fun browsers(activity: MainActivity): Int {
        var count = 0
        fun visit(view: View) {
            if (view is WebView) count++
            if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
        }
        instrumentation.runOnMainSync { visit(activity.window.decorView) }
        return count
    }
    private fun await(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) { if (condition()) return; Thread.sleep(50) }
        fail(message)
    }
    private val bundle = """{"kiosk_id":1,"kiosk_name":"Power fixture","version":"1","cameras":[],"displays":[{
      "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
      "layouts":[{"id":3,"name":"Default","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
      "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Original</p>"}]}]}]}"""
}
