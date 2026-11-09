package cloud.betterportal.frame

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OverlayTileTest {
    private fun cell(id: String, web: Boolean = false, overlay: Boolean = true) = org.json.JSONObject().apply {
        put("id", id); put("kind", if (web) "web" else "camera")
        if (web) put("web", org.json.JSONObject().put("html", "<p>Page</p>"))
        if (overlay) put("overlayHtml", "<p>Overlay</p>")
    }

    @Test fun basePagesAndOverlaysShareOneBrowserBudget() {
        val cameras = (0 until 32).map { cell("camera-$it") }
        val pages = (0 until 32).map { cell("page-$it", web = true) }
        val full = compatibleWebSessions(cameras + pages)
        assertEquals(32, full.count { it.optString("kind") == "web" })
        assertEquals(0, full.count { it.has("overlayHtml") })
        val partial = compatibleWebSessions(cameras + pages.take(16))
        assertEquals(16, partial.count { it.optString("kind") == "web" })
        assertEquals((0 until 16).map { "camera-$it" }, partial.filter { it.has("overlayHtml") }.map { it.getString("id") })
        val rejected = compatibleWebSessions((0 until 64).map { cell("page-$it", web = true) })
        assertTrue(rejected.filter { it.optString("kind") == "placeholder" }.none { it.has("overlayHtml") })
        assertTrue(compatibleWebSessions(cameras, 0).none { it.has("overlayHtml") })
        assertTrue("budget projection must not mutate cached input", cameras.all { it.has("overlayHtml") })
    }

    @Test fun overlayUpdatesPreserveBaseChildrenAndReleaseTheirBrowser() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val tile = PlaceholderTile(instrumentation.targetContext, "Gate", "Preview")
            val base = tile.getChildAt(0)
            val count = tile.childCount
            tile.updateOverlay("<p>12%</p>")
            assertEquals(count + 1, tile.childCount)
            val overlay = tile.getChildAt(count)
            assertTrue(overlay is WebView)
            tile.updateOverlay("<p>64%</p>")
            assertSame(base, tile.getChildAt(0))
            assertSame(overlay, tile.getChildAt(count))
            tile.updateOverlay(null)
            assertEquals(count, tile.childCount)
            assertSame(base, tile.getChildAt(0))
            tile.updateOverlay("<p>Restored</p>")
            tile.releaseOverlay()
            tile.release()
            assertEquals(count, tile.childCount)
        }
    }
}
