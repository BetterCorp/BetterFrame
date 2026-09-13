package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ViewerActionsTest {
    @Test fun htmlToolbarHonorsAssignedActionsWithoutInterceptingPageInteraction() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "actions-test-${System.nanoTime()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getApplicationContext(): Context = this
        }
        // A previously verified cache keeps local controls usable while the server is offline.
        ProtectedStore(isolated).write(JSONObject()
            .put("server", "http://127.0.0.1:9")
            .put("identity", JSONObject().put("kiosk_key", "test-device-key"))
            .put("bundle_profile", "android-viewer-v1")
            .put("bundle", bundle))
        // Prevent the initial Activity session contacting the hosted default before replacement below.
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        lateinit var session: ViewerSession
        try {
            instrumentation.runOnMainSync {
                // Isolate enrollment/cache from other activity tests, retaining the actual UI/session wiring.
                val field = MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
                (field.get(activity) as ViewerSession).close()
                session = ViewerSession(isolated, activity)
                field.set(activity, session)
                session.start()
            }
            fun awaitUi(message: String, condition: () -> Boolean) {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                var satisfied = false
                while (!satisfied && System.nanoTime() < deadline) {
                    instrumentation.runOnMainSync { satisfied = condition() }
                    if (!satisfied) Thread.sleep(50)
                }
                assertTrue(message, satisfied)
            }
            fun tileButton(text: String): Button? = descendants(activity.window.decorView)
                .filterIsInstance<WebTile>().flatMap(::descendants).filterIsInstance<Button>()
                .firstOrNull { it.text.toString() == text }
            fun globalRestore(): Button = descendants(activity.window.decorView)
                .filterIsInstance<Button>().first { it.text.toString() == "Restore" }

            awaitUi("Cached HTML layout did not load") { tileButton("Switch layout") != null }
            instrumentation.runOnMainSync {
                tileButton("Interact")!!.performClick()
                assertNotNull("Entering the page must preserve the assigned layout", tileButton("Switch layout"))
                tileButton("Exit page")!!.performClick()
                tileButton("Switch layout")!!.performClick()
            }
            awaitUi("HTML action must switch to the assigned layout, not expand its current tile") {
                tileButton("Switch layout") == null && tileButton("Restore") != null
            }
            instrumentation.runOnMainSync { session.expand("20") }
            awaitUi("Expanded HTML must expose the global restore control") { globalRestore().isShown }
            instrumentation.runOnMainSync { tileButton("Restore")!!.performClick() }
            awaitUi("Assigned restore action must leave the expanded view") { !globalRestore().isShown }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            ProtectedStore(context).clear()
            directory.deleteRecursively()
        }
    }

    private fun descendants(view: View): List<View> = buildList {
        add(view)
        if (view is ViewGroup) for (i in 0 until view.childCount) addAll(descendants(view.getChildAt(i)))
    }

    private val bundle = """{
      "kiosk_id":1,"kiosk_name":"Lobby","version":"1","cameras":[],"displays":[{
        "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
        "layouts":[
          {"id":3,"name":"Navigation","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":true,
           "cells":[{"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Navigation</p>",
             "input_options":{"events":{"click":{"action":"layout.switch","params":{"layout_id":4}}}}}]},
          {"id":4,"name":"Details","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":false,"resets_idle_timer":true,
           "cells":[{"view_id":20,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"html","html_content":"<p>Details</p>",
             "input_options":{"events":{"click":{"action":"restore","params":{}}}}}]}]}]}
    """
}
