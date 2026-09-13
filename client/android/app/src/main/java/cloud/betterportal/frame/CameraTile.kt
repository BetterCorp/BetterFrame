package cloud.betterportal.frame

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
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
    private var connectionStartedAt = 0L
    @Volatile private var lastVideoFrameAt = 0L
    @Volatile private var lastPresentationTimeUs = Long.MIN_VALUE
    @Volatile private var frameGeneration = 0
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
            if (player == null) return
            // RTSP playback time may advance while video is frozen; only rendered-frame
            // metadata refreshes this clock. Allow the initial keyframe/decoder more time.
            val lastFrame = lastVideoFrameAt
            val quietFor = SystemClock.elapsedRealtime() - if (lastFrame > 0L) lastFrame else connectionStartedAt
            if (quietFor >= if (firstFrame) 15_000L else 20_000L) {
                recover()
                return
            }
            if (firstFrame) {
                status.text = "Camera stalled · reconnecting"
                status.visibility = if (quietFor >= 5_000L) View.VISIBLE else View.GONE
            }
            handler.postDelayed(this, 5_000)
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
        connectionStartedAt = SystemClock.elapsedRealtime()
        lastVideoFrameAt = 0L
        lastPresentationTimeUs = Long.MIN_VALUE
        val frameEpoch = ++frameGeneration
        if (!uri.startsWith("rtsp://", ignoreCase = true)) {
            status.text = "Camera requires a supported RTSP stream"
            return
        }
        try {
            val renderers = DefaultRenderersFactory(context)
                .setEnableDecoderFallback(false)
                .setMediaCodecSelector(MediaCodecSelector { mimeType, secure, tunneling ->
                    MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling)
                        .filter { !mimeType.startsWith("video/") || it.hardwareAccelerated }
                })
            val next = ExoPlayer.Builder(context, renderers)
                .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(500, 2_000, 250, 500).build())
                .build()
            player = next
            next.volume = 0f
            next.trackSelectionParameters = next.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build()
            next.setVideoFrameMetadataListener { presentationTimeUs, _, _, _ ->
                // Callback runs on the playback thread. Ignore retired players without
                // posting a main-thread message for every decoded frame.
                if (frameGeneration == frameEpoch && presentationTimeUs != lastPresentationTimeUs) {
                    lastPresentationTimeUs = presentationTimeUs
                    lastVideoFrameAt = SystemClock.elapsedRealtime()
                }
            }
            playerView.player = next
            next.addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    if (player !== next) return
                    firstFrame = true
                    status.visibility = View.GONE
                    retries = 0
                }
                override fun onPlaybackStateChanged(state: Int) {
                    if (player !== next) return
                    if (state == Player.STATE_BUFFERING && firstFrame) {
                        status.text = "Camera interrupted · reconnecting"
                        status.visibility = View.VISIBLE
                    } else if (state == Player.STATE_READY && firstFrame) {
                        status.visibility = View.GONE
                    } else if (state == Player.STATE_ENDED) recover()
                }
                override fun onPlayerError(error: PlaybackException) { if (player === next) recover() }
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
        frameGeneration++
        playerView.player = null
        val previous = player
        player = null
        previous?.release()
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
        frameGeneration++
        playerView.player = null
        val previous = player
        player = null
        previous?.release()
    }
}
