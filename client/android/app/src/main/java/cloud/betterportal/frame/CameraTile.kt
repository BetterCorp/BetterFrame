package cloud.betterportal.frame

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ProgressBar
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
    private val diagnosticId = CameraDiagnostics.identifier(camera.optString("id"))
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
        // Zoom intentionally makes the inner video surface larger than its cell.
        // SurfaceView is composed separately: clip the PlayerView's render bounds,
        // not just ordinary child drawing, so video cannot cover adjacent blocks.
        outlineProvider = ViewOutlineProvider.BOUNDS
        clipToOutline = true
        clipChildren = true
        clipToPadding = true
        resizeMode = when (cell.optString("fit")) {
            "contain" -> AspectRatioFrameLayout.RESIZE_MODE_FIT
            "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            else -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
        }
    }
    private val status = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    private val spinner = ProgressBar(context).apply {
        isIndeterminate = true
        indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.LTGRAY)
        contentDescription = "Connecting camera"
    }
    private val errorMessage = message("").apply { setBackgroundColor(Color.BLACK); visibility = View.GONE }
    private val label = TextView(context).apply {
        text = cell.optString("label", "Camera")
        setSingleLine(true)
        ellipsize = android.text.TextUtils.TruncateAt.END
        setTextColor(Color.WHITE)
        setBackgroundColor(0x99000000.toInt())
        setPadding(12, 8, 12, 8)
        visibility = View.GONE
    }
    private val watchdog = object : Runnable {
        override fun run() {
            if (released) return
            if (player == null) return
            // RTSP playback time may advance while video is frozen; only rendered-frame
            // metadata refreshes this clock. Allow the initial keyframe/decoder more time.
            val lastFrame = lastVideoFrameAt
            val quietFor = SystemClock.elapsedRealtime() - if (lastFrame > 0L) lastFrame else connectionStartedAt
            if (quietFor >= if (firstFrame) 15_000L else 20_000L) {
                logDiagnostic("warn", "Playback stalled quietMs=$quietFor")
                recover()
                return
            }
            if (firstFrame) {
                if (quietFor >= 5_000L) showConnecting() else showReady()
            }
            handler.postDelayed(this, 5_000)
        }
    }

    init {
        setBackgroundColor(Color.BLACK)
        outlineProvider = ViewOutlineProvider.BOUNDS
        clipToOutline = true
        clipChildren = true
        clipToPadding = true
        addView(playerView, LayoutParams(-1, -1))
        val spinnerSize = (36 * resources.displayMetrics.density).toInt()
        status.addView(errorMessage, LayoutParams(-1, -1))
        status.addView(spinner, LayoutParams(spinnerSize, spinnerSize, Gravity.CENTER))
        addView(status, LayoutParams(-1, -1))
        addView(label, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START))
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
        showConnecting()
        firstFrame = false
        connectionStartedAt = SystemClock.elapsedRealtime()
        lastVideoFrameAt = 0L
        lastPresentationTimeUs = Long.MIN_VALUE
        val frameEpoch = ++frameGeneration
        if (!uri.startsWith("rtsp://", ignoreCase = true)) {
            logDiagnostic("warn", "Unsupported stream scheme")
            spinner.visibility = View.GONE
            errorMessage.text = "Camera requires a supported RTSP stream"
            errorMessage.visibility = View.VISIBLE
            return
        }
        try {
            val renderers = DefaultRenderersFactory(context)
                // Some TVs can only allocate a handful of hardware decoder instances.
                // Keep hardware preferred, but allow Media3 to try platform software
                // decoders when another hardware instance cannot be initialized.
                .setEnableDecoderFallback(true)
                .setMediaCodecSelector(MediaCodecSelector { mimeType, secure, tunneling ->
                    CameraDecoderPolicy.candidates(
                        mimeType,
                        MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling),
                    ) { it.hardwareAccelerated }
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
                    showReady()
                    if (retries > 0) logDiagnostic("info", "Playback recovered")
                    retries = 0
                }
                override fun onPlaybackStateChanged(state: Int) {
                    if (player !== next) return
                    if (state == Player.STATE_BUFFERING && firstFrame) {
                        showConnecting()
                    } else if (state == Player.STATE_READY && firstFrame) {
                        showReady()
                    } else if (state == Player.STATE_ENDED) {
                        logDiagnostic("warn", "Stream ended")
                        recover()
                    }
                }
                override fun onPlayerError(error: PlaybackException) {
                    if (player !== next) return
                    logDiagnostic("warn", "Camera playback failed (${error.errorCodeName}, code=${error.errorCode}) causes=${CameraDiagnostics.causes(error)}")
                    val decoderFailure = error.errorCode in setOf(
                        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                        PlaybackException.ERROR_CODE_DECODING_FAILED,
                        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
                        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
                    )
                    recover(if (decoderFailure) "Camera decoding unavailable. Reduce camera count or stream quality. Retrying…" else null)
                }
            })
            val source = RtspMediaSource.Factory().setForceUseRtpTcp(true).setTimeoutMs(10_000)
                .createMediaSource(MediaItem.fromUri(uri))
            next.setMediaSource(source)
            next.prepare()
            next.playWhenReady = true
            handler.postDelayed(watchdog, 5_000)
        } catch (error: Exception) {
            logDiagnostic("warn", "Camera startup failed causes=${CameraDiagnostics.causes(error)}")
            recover()
        }
    }

    private fun logDiagnostic(level: String, detail: String) {
        val stream = if (fallbackUri != null && uri == fallbackUri) "fallback" else "primary"
        DiagnosticLogs.record(level, "Camera id=$diagnosticId stream=$stream transport=tcp retry=$retries firstFrame=$firstFrame: $detail")
    }

    private fun recover(message: String? = null) {
        if (released) return
        handler.removeCallbacksAndMessages(null)
        frameGeneration++
        playerView.player = null
        val previous = player
        player = null
        previous?.release()
        showConnecting()
        if (message != null) {
            spinner.visibility = View.GONE
            errorMessage.text = message
            errorMessage.visibility = View.VISIBLE
        }
        if (fallbackUri != null && uri != fallbackUri) uri = fallbackUri
        retries = min(retries + 1, 6)
        val delay = min(30_000L, 1_000L shl retries) + Random.nextLong(250, 1_000)
        logDiagnostic("info", "Reconnect scheduled delayMs=$delay")
        handler.postDelayed({ connect() }, delay)
    }

    private fun showConnecting() {
        status.visibility = View.VISIBLE
        spinner.visibility = View.VISIBLE
        errorMessage.visibility = View.GONE
        label.visibility = View.GONE
    }

    private fun showReady() {
        status.visibility = View.GONE
        label.visibility = View.VISIBLE
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
