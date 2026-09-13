package net.bettercorp.betterframe.viewer

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import kotlin.math.min
import kotlin.random.Random

@UnstableApi
class CameraTile(context: Context, cell: JSONObject, onExpand: () -> Unit) : ViewerTile(context) {
    private val handler = Handler(Looper.getMainLooper())
    private val camera = cell.getJSONObject("camera")
    private var uri = camera.optString("uri")
    private val fallbackUri = camera.optString("fallbackUri").takeUnless { it.isBlank() || it == "null" }
    private var player: ExoPlayer? = null
    private var released = false
    private var retries = 0
    private var firstFrame = false
    private var lastPosition = -1L
    private var stagnantChecks = 0
    private val playerView = PlayerView(context).apply {
        useController = false
        isFocusable = false
        isClickable = false
        setShutterBackgroundColor(Color.BLACK)
        resizeMode = when (cell.optString("fit")) {
            "contain" -> AspectRatioFrameLayout.RESIZE_MODE_FIT
            "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            else -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
        }
    }
    private val status = message("Connecting camera…")
    private val watchdog = object : Runnable {
        override fun run() {
            if (released) return
            val current = player ?: return
            val position = current.currentPosition
            stagnantChecks = if (!firstFrame || position == lastPosition) stagnantChecks + 1 else 0
            lastPosition = position
            if (stagnantChecks >= 4) recover() else handler.postDelayed(this, 5_000)
        }
    }

    init {
        setBackgroundColor(Color.BLACK)
        addView(playerView, LayoutParams(-1, -1))
        addView(status, LayoutParams(-1, -1))
        addView(TextView(context).apply {
            text = cell.optString("label", "Camera")
            setTextColor(Color.WHITE)
            setBackgroundColor(0x99000000.toInt())
            setPadding(12, 8, 12, 8)
        }, LayoutParams(-1, -2, Gravity.BOTTOM))
        // This app-owned surface is the single TV focus target and touch expand control.
        addView(View(context).apply {
            isFocusable = true
            isClickable = true
            contentDescription = "Expand ${cell.optString("label", "camera")}"
            focusBorder(this)
            setOnClickListener { onExpand() }
        }, LayoutParams(-1, -1))
        connect()
    }

    private fun connect() {
        if (released) return
        status.visibility = View.VISIBLE
        status.text = if (retries == 0) "Connecting camera…" else "Camera unavailable · reconnecting"
        firstFrame = false
        lastPosition = -1
        stagnantChecks = 0
        if (!uri.startsWith("rtsp://", ignoreCase = true)) {
            status.text = "Camera requires a supported RTSP stream"
            return
        }
        try {
            val next = ExoPlayer.Builder(context)
                .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(500, 2_000, 250, 500).build())
                .build()
            player = next
            next.volume = 0f
            playerView.player = next
            next.addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    firstFrame = true
                    status.visibility = View.GONE
                    retries = 0
                }
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_BUFFERING && firstFrame) {
                        status.text = "Camera interrupted · reconnecting"
                        status.visibility = View.VISIBLE
                    } else if (state == Player.STATE_READY && firstFrame) {
                        status.visibility = View.GONE
                    } else if (state == Player.STATE_ENDED) recover()
                }
                override fun onPlayerError(error: PlaybackException) { recover() }
            })
            val source = RtspMediaSource.Factory().setForceUseRtpTcp(true).setTimeoutMs(10_000)
                .createMediaSource(MediaItem.fromUri(uri))
            next.setMediaSource(source)
            next.prepare()
            next.playWhenReady = true
            handler.postDelayed(watchdog, 5_000)
        } catch (_: Exception) { recover() }
    }

    private fun recover() {
        if (released) return
        handler.removeCallbacksAndMessages(null)
        playerView.player = null
        player?.release()
        player = null
        status.text = "Camera unavailable · reconnecting"
        status.visibility = View.VISIBLE
        if (fallbackUri != null && uri != fallbackUri) uri = fallbackUri
        retries = min(retries + 1, 6)
        val delay = min(30_000L, 1_000L shl retries) + Random.nextLong(250, 1_000)
        handler.postDelayed({ connect() }, delay)
    }

    override fun release() {
        released = true
        handler.removeCallbacksAndMessages(null)
        playerView.player = null
        player?.release()
        player = null
    }
}
