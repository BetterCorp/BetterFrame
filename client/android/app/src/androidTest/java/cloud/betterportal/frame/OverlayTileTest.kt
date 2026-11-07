package cloud.betterportal.frame

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OverlayTileTest {
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
