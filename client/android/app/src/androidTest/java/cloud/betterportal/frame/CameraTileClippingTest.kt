package cloud.betterportal.frame

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Tests SurfaceFlinger composition, not View.draw(), which omits SurfaceView pixels. */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class CameraTileClippingTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private var activity: Activity? = null
    private var tile: CameraTile? = null

    @After fun finish() {
        instrumentation.runOnMainSync { tile?.release(); activity?.finish() }
        ProtectedStore(instrumentation.targetContext).clear()
    }

    @Test fun zoomedSurfaceCannotPaintAdjacentBlocksAfterAspectAndSizeChanges() {
        val context = instrumentation.targetContext
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        lateinit var root: FrameLayout
        lateinit var player: PlayerView
        lateinit var surface: SurfaceView
        lateinit var content: AspectRatioFrameLayout
        instrumentation.runOnMainSync {
            (MainActivity::class.java.getDeclaredField("session").apply { isAccessible = true }
                .get(activity) as ViewerSession).stop()
            root = FrameLayout(activity!!).apply { setBackgroundColor(Color.MAGENTA) }
            // Invalid URI avoids all network/decoder dependencies. Draw into the real
            // production SurfaceView directly, as a decoder would supply its buffers.
            tile = CameraTile(activity!!, JSONObject().put("fit", "cover")
                .put("camera", JSONObject().put("uri", "test://synthetic"))) {}
            player = tile!!.getChildAt(0) as PlayerView
            for (index in 1 until tile!!.childCount) tile!!.getChildAt(index).visibility = View.GONE
            player.findViewById<View>(androidx.media3.ui.R.id.exo_shutter).visibility = View.GONE
            surface = player.videoSurfaceView as SurfaceView
            content = player.findViewById(androidx.media3.ui.R.id.exo_content_frame)
            root.addView(tile, FrameLayout.LayoutParams(100, 100))
            activity!!.setContentView(root)
        }
        await("root layout") { root.width > 0 && root.height > 0 }
        // Wide and tall streams overflow opposite axes. The final case changes the
        // cell dimensions too, reproducing layout rotation/expanded-camera return.
        for ((ratio, divisor) in listOf(4f to 3, 0.25f to 3, 4f to 2)) {
            val bounds = Rect()
            instrumentation.runOnMainSync {
                val width = root.width / divisor
                val height = root.height / divisor
                tile!!.layoutParams = FrameLayout.LayoutParams(width, height).apply {
                    leftMargin = (root.width - width) / 2
                    topMargin = (root.height - height) / 2
                }
                content.setAspectRatio(ratio)
            }
            await("zoomed surface layout for $ratio/$divisor") {
                surface.holder.surface.isValid && !tile!!.isLayoutRequested && !content.isLayoutRequested &&
                    !surface.isLayoutRequested &&
                    (surface.width > tile!!.width || surface.height > tile!!.height)
            }
            instrumentation.runOnMainSync {
                val position = IntArray(2)
                tile!!.getLocationOnScreen(position)
                bounds.set(position[0], position[1], position[0] + tile!!.width, position[1] + tile!!.height)
                val canvas = requireNotNull(surface.holder.lockCanvas()) { "Synthetic video buffer" }
                try { canvas.drawColor(Color.GREEN) } finally { surface.holder.unlockCanvasAndPost(canvas) }
            }
            val deadline = SystemClock.uptimeMillis() + 5_000
            var composed = false
            while (SystemClock.uptimeMillis() < deadline) {
                val shot = instrumentation.uiAutomation.takeScreenshot()
                try {
                    if (shot != null && sameColor(shot.getPixel(bounds.centerX(), bounds.centerY()), Color.GREEN)) {
                        // Sample all four sides, including the gutters immediately
                        // outside the cell. A zoomed SurfaceView must not cover them.
                        val samples = listOf(2, 8).flatMap { offset ->
                            listOf(
                                bounds.left - offset to bounds.centerY(),
                                bounds.right + offset to bounds.centerY(),
                                bounds.centerX() to bounds.top - offset,
                                bounds.centerX() to bounds.bottom + offset,
                            )
                        }
                        // SurfaceFlinger may apply a resized crop one frame later.
                        // Wait for the complete composition, not just the old green buffer.
                        if (samples.all { (x, y) -> sameColor(shot.getPixel(x, y), Color.MAGENTA) }) {
                            composed = true
                            break
                        }
                    }
                } finally { shot?.recycle() }
                SystemClock.sleep(50)
            }
            assertTrue("Video must appear inside the cell with all gutters untouched: ratio=$ratio, cell=$bounds", composed)
        }
    }

    private fun await(description: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            var ready = false
            instrumentation.runOnMainSync { ready = condition() }
            if (ready) return
            SystemClock.sleep(50)
        }
        fail("Timed out waiting for $description")
    }

    private fun sameColor(actual: Int, expected: Int): Boolean =
        kotlin.math.abs(Color.red(actual) - Color.red(expected)) < 10 &&
            kotlin.math.abs(Color.green(actual) - Color.green(expected)) < 10 &&
            kotlin.math.abs(Color.blue(actual) - Color.blue(expected)) < 10
}
