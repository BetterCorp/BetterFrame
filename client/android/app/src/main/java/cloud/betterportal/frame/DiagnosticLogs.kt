package cloud.betterportal.frame

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** App-owned diagnostics only; Android does not grant us the system journal. */
internal object DiagnosticLogs {
    private data class Destination(val server: String, val key: String, val kiosk: String) {
        val owner get() = "$server|$kiosk"
    }
    private val pending = ArrayDeque<JSONObject>()
    private var destination: Destination? = null
    private var store: ProtectedStore? = null
    private var restored = false
    private var lastMessage = ""
    private var lastLevel = ""
    private var lastMessageAt = 0L
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(10, TimeUnit.SECONDS).build()

    @Synchronized fun initialize(context: Context) {
        if (store != null) return
        store = ProtectedStore(context.applicationContext, "diagnostic-logs.enc")
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // Persist a bounded stack without exception messages (which can contain URLs/secrets).
            record("error", "Uncaught ${error.javaClass.simpleName}: ${error.stackTrace.take(64).joinToString("\n")}")
            synchronized(this) { persist() }
            previous?.uncaughtException(thread, error)
        }
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({
            try { flush() } catch (_: Exception) { /* Retain for retry; never recurse into logging. */ }
        }, 5, 5, TimeUnit.SECONDS)
        record("info", "Android application started (${BuildConfig.VERSION_NAME})")
    }

    @Synchronized fun bind(server: String, key: String, kiosk: String) {
        val next = if (server.isNotBlank() && key.isNotBlank() && kiosk.isNotBlank()) Destination(server, key, kiosk) else null
        if (destination != null && destination?.owner != next?.owner) {
            pending.clear()
            try { store?.clear() } catch (_: Exception) { }
        }
        destination = next
        if (!restored && next != null) {
            restored = true
            try {
                val saved = store?.read()
                if (saved?.optString("owner") == next.owner) {
                    val entries = saved.optJSONArray("entries") ?: JSONArray()
                    val startup = pending.toList()
                    pending.clear()
                    for (i in 0 until entries.length()) pending.addLast(entries.getJSONObject(i))
                    startup.forEach { pending.addLast(it) }
                    while (pending.size > 1000) pending.removeFirst()
                }
            } catch (_: Exception) { }
        }
    }

    @Synchronized fun record(level: String, message: String) {
        val time = System.currentTimeMillis()
        // Status callbacks can repeat every second while offline.
        if (message == lastMessage && level == lastLevel && time - lastMessageAt < 60_000) return
        lastMessage = message; lastLevel = level; lastMessageAt = time
        val scrubbed = message.replace(Regex("(?i)(bearer|basic)\\s+\\S+"), "[redacted]")
            .replace(Regex("(?i)\\S*(password|secret|token|authorization|cookie|kiosk_key|api_key)\\S*(?:\\s+\\S+)?"), "[redacted]")
            .replace(Regex("\\S*://\\S+"), "[url]")
        val safe = scrubbed.take(16384)
        val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(time))
        pending.addLast(JSONObject().put("event_id", "android:${UUID.randomUUID()}")
            .put("level", level).put("message", safe).put("logged_at", timestamp)
            .put("context", JSONObject().put("source", "app").put("platform", "android")
                .put("version", BuildConfig.VERSION_NAME).put("pid", android.os.Process.myPid())
                .put("truncated", scrubbed.length > 16384)))
        while (pending.size > 1000) pending.removeFirst()
    }

    private fun persist() {
        val dest = destination ?: return
        try { store?.write(JSONObject().put("owner", dest.owner).put("entries", JSONArray(pending.toList()))) } catch (_: Exception) { }
    }

    private fun flush() {
        val (dest, batch) = synchronized(this) {
            val dest = destination ?: return
            persist()
            dest to pending.take(100)
        }
        if (batch.isEmpty()) return
        val request = Request.Builder().url(dest.server.trimEnd('/') + "/api/kiosk/logs")
            .header("Authorization", "Bearer ${dest.key}")
            .post(JSONObject().put("entries", JSONArray(batch)).toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { response ->
            if (response.isSuccessful) synchronized(this) {
                if (destination?.owner == dest.owner) {
                    val ids = batch.map { it.getString("event_id") }.toSet()
                    pending.removeAll { it.getString("event_id") in ids }
                    persist()
                }
            }
        }
    }
}
