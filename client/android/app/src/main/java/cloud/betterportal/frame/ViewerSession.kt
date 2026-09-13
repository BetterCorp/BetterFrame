package cloud.betterportal.frame

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.CompletableFuture
import java.util.UUID

/** Reset survives Activity destruction; the protected marker also survives process loss. */
internal object EnrollmentCleanup {
    const val MARKER = "enrollment_cleanup"
    data class Claim(val token: String, val created: Boolean)
    private class Job(val token: String, val persisted: CompletableFuture<Unit>) {
        val listeners = mutableListOf<(Boolean) -> Unit>()
        var started = false
    }
    private val jobs = mutableMapOf<String, Job>()
    private data class ResetVersion(val generation: Long, val token: String)
    // Keep the tombstone after cleanup so delayed writes stay invalidated.
    private val versions = mutableMapOf<String, ResetVersion>()
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private fun key(context: Context) = context.noBackupFilesDir.absolutePath

    @Synchronized fun pending(context: Context): String? = jobs[key(context)]?.token

    @Synchronized fun begin(context: Context, token: String): Claim {
        val path = key(context)
        jobs[path]?.let { return Claim(it.token, false) }
        versions[path] = ResetVersion((versions[path]?.generation ?: 0L) + 1, token)
        jobs[path] = Job(token, CompletableFuture())
        return Claim(token, true)
    }

    @Synchronized fun read(context: Context, read: () -> JSONObject): Pair<Long, JSONObject> {
        val path = key(context)
        val state = read()
        val marker = state.optString(MARKER)
        // Adopt a marker restored from disk once, before any session can write.
        if (marker.isNotBlank() && !jobs.containsKey(path) && versions[path]?.token != marker) {
            versions[path] = ResetVersion((versions[path]?.generation ?: 0L) + 1, marker)
        }
        return (versions[path]?.generation ?: 0L) to state
    }

    // Share this lock with registration so an older session cannot write across reset.
    @Synchronized fun writeIfIdle(context: Context, generation: Long, write: () -> Unit): Boolean {
        val path = key(context)
        if (jobs.containsKey(path) || generation != (versions[path]?.generation ?: 0L)) return false
        write()
        return true
    }

    @Synchronized fun persisted(context: Context, token: String, error: Throwable? = null) {
        jobs[key(context)]?.takeIf { it.token == token }?.let {
            if (error == null) it.persisted.complete(Unit) else it.persisted.completeExceptionally(error)
        }
    }

    @Synchronized fun request(context: Context, token: String, clear: (Context, (Boolean) -> Unit) -> Unit, done: (Boolean) -> Unit) {
        val path = key(context)
        val job = jobs.getOrPut(path) { Job(token, CompletableFuture.completedFuture(Unit)) }
        job.listeners.add(done)
        if (job.started) return
        job.started = true
        val store = ProtectedStore(context)
        fun finish(success: Boolean) {
            val listeners = synchronized(this) {
                if (jobs[path] !== job) return
                jobs.remove(path)
                job.listeners.toList()
            }
            main.post { listeners.forEach { it(success) } }
        }
        worker.execute {
            try {
                job.persisted.get()
                // A stale reader may join just after another instance completed.
                if (store.read().optString(MARKER) != job.token) { finish(true); return@execute }
                main.post {
                    try {
                        clear(context) { cleared ->
                            if (!cleared) finish(false)
                            else worker.execute {
                                try {
                                    val latest = store.read()
                                    if (latest.optString(MARKER) == job.token) {
                                        latest.remove(MARKER)
                                        if (latest.length() == 0) store.clear() else store.write(latest)
                                    }
                                    finish(true)
                                } catch (_: Exception) { finish(false) }
                            }
                        }
                    } catch (_: Exception) { finish(false) }
                }
            } catch (_: Exception) { finish(false) }
        }
    }
}

/** Outbound display client only. All network/storage work is serialized away from the UI. */
class ViewerSession internal constructor(context: Context, private val listener: Listener,
                                        private val http: OkHttpClient = defaultHttp(),
                                        private val clearBrowserSessions: (Context, (Boolean) -> Unit) -> Unit = { app, done -> WebTile.clearSessions(app, done) },
                                        private val monotonicTime: () -> Long = SystemClock::elapsedRealtime) {
    private companion object {
        const val VIEWER_PROFILE = "android-viewer-v1"
        const val AUTH_REJECTED = "Display authorization rejected. Check this device in BF."
        const val PROFILE_REQUIRED = "This BF server must support android-viewer-v1. Update the server to use this display."
        const val NO_LAYOUTS_ASSIGNED = "go into BetterFrame and assign layouts to this display"
        fun defaultHttp() = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    }
    interface Listener {
        fun onServerAddress(address: String) {}
        fun onStatus(message: String)
        fun onPairing(code: String)
        fun onPlan(plan: JSONObject)
    }
    private val app = context.applicationContext
    private val store = ProtectedStore(app)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor()
    // Projection is independent of potentially slow network I/O, so local touch/remote actions stay responsive.
    private val renderer = Executors.newSingleThreadScheduledExecutor()
    private data class RenderSnapshot(val raw: String, val server: String, val encryptKey: String?, val cookieReady: Boolean, val epoch: Int)
    @Volatile private var renderSnapshot: RenderSnapshot? = null
    private data class IdlePolicy(val snapshot: RenderSnapshot, val timeoutMs: Long,
                                  val layout: String, val defaultLayout: String,
                                  val returnToDefault: Boolean, val expanded: Boolean)
    private var idlePolicy: IdlePolicy? = null // Renderer-thread owned.
    @Volatile private var idleLoop: ScheduledFuture<*>? = null
    @Volatile private var lastActivity = 0L
    private var serverResolved = false
    private var state = JSONObject()
    @Volatile private var storageGeneration = -1L
    private var loop: ScheduledFuture<*>? = null
    private var socket: WebSocket? = null
    private var socketConnecting = false
    private var nextSocketAttempt = 0L
    private var nextSync = 0L
    private var nextCookie = 0L
    private var nextPairPoll = 0L
    private var failures = 0
    private var awaitingAssignment = false
    private var operation = "server discovery"
    private var activeEpoch = 0
    private var dashboardSessionReady = false
    private var profileVerified = false
    @Volatile private var closed = false
    @Volatile private var clearingEnrollment = false
    private data class PendingStart(val server: String?)
    private var pendingStart: PendingStart? = null
    @Volatile private var layoutId: String? = null
    @Volatile private var expandedId: String? = null
    @Volatile private var generation = 0
    @Volatile private var running = false
    @Volatile var serverUrl: String = ""
        private set
    @Volatile var kioskKey: String = ""
        private set

    private fun ui(epoch: Int = generation, action: () -> Unit) {
        main.post { if (running && generation == epoch) action() }
    }
    private fun status(message: String) = ui(activeEpoch) { listener.onStatus(message) }
    private fun active() = running && generation == activeEpoch && !closed
    private fun ensureActive() { check(active()) { "Session stopped" } }
    private fun persist() {
        ensureActive()
        check(EnrollmentCleanup.writeIfIdle(app, storageGeneration) { store.write(state) }) { "Enrollment reset invalidated this session" }
    }
    private fun JSONObject.textValue(name: String): String? = optString(name).takeUnless { it.isBlank() || it == "null" }
    // OkHttp can deliver a final callback after Activity destruction.
    private fun enqueue(action: () -> Unit) {
        try { worker.execute(action) } catch (_: RejectedExecutionException) { /* Session was closed. */ }
    }
    private fun currentWork(action: () -> Unit) {
        val epoch = generation
        enqueue { if (running && generation == epoch && !closed) action() }
    }
    private fun renderWork(action: (RenderSnapshot) -> Unit) {
        val epoch = generation
        try {
            renderer.execute {
                val snapshot = renderSnapshot
                if (snapshot != null && snapshot.epoch == epoch && running && generation == epoch && !closed) action(snapshot)
            }
        } catch (_: RejectedExecutionException) { /* Session was closed. */ }
    }
    private fun persistSelection(id: String?, epoch: Int) = enqueue {
        if (running && generation == epoch && layoutId == id) {
            if (id == null) state.remove("layout_id") else state.put("layout_id", id)
            try { persist() } catch (_: Exception) { status("Layout selected; unable to save it for restart") }
        }
    }

    fun start(serverUrl: String? = null) {
        if (closed) return
        if (clearingEnrollment) { pendingStart = PendingStart(serverUrl); return }
        if (running) { if (serverUrl != null && serverUrl.trimEnd('/') != this.serverUrl) status("Unpair before changing the BF server"); return }
        running = true
        recordActivity()
        val epoch = ++generation
        enqueue {
            if (generation != epoch || !running) return@enqueue
            activeEpoch = epoch
            dashboardSessionReady = false
            profileVerified = false
            nextCookie = 0L
            nextSocketAttempt = 0L
            failures = 0
            awaitingAssignment = false
            try {
                val loaded = EnrollmentCleanup.read(app) { store.read() }
                storageGeneration = loaded.first
                state = loaded.second
                val cleanup = EnrollmentCleanup.pending(app) ?: state.textValue(EnrollmentCleanup.MARKER)
                if (cleanup != null) {
                    clearingEnrollment = true
                    running = false
                    // Keep the resume request only if no subsequent stop cancelled it.
                    main.post {
                        if (!closed && generation == epoch) pendingStart = PendingStart(serverUrl)
                        continueEnrollmentCleanup(cleanup)
                    }
                    return@enqueue
                }
                // Older app versions could cache an unrestricted legacy bundle.
                if (state.optString("bundle_profile") != VIEWER_PROFILE) clearCachedBundle()
                // A resumed unassigned cache may keep receiving 304 responses.
                // Restore its setup polling cadence before the first heartbeat.
                awaitingAssignment = state.optString("bundle").takeIf { it.isNotBlank() }?.let {
                    JSONObject(NativeCore.renderPlan(it, null, null)).optString("error") == NO_LAYOUTS_ASSIGNED
                } ?: false
                val saved = state.optString("server")
                val origin = ServerAddress.enrollmentOrigin(serverUrl, saved)
                require(saved.isBlank() || saved == origin) { "Unpair before changing the BF server" }
                this.serverUrl = origin
                serverResolved = state.optString("resolved_server") == origin
                ui(epoch) { listener.onServerAddress(origin) }
                state.put("server", origin)
                kioskKey = state.optJSONObject("identity")?.textValue("kiosk_key") ?: ""
                layoutId = state.optString("layout_id").takeIf { it.isNotBlank() }
                persist()
                if (!state.optBoolean("blocked")) emitPlan()
                else status(state.optString("block_reason", AUTH_REJECTED))
                idleLoop?.cancel(false)
                val idle = renderer.scheduleWithFixedDelay({ checkIdle(epoch) }, 250, 250, TimeUnit.MILLISECONDS)
                idleLoop = idle
                if (!active()) idle.cancel(false) // stop() may race initial cache loading.
                nextSync = 0L
                nextPairPoll = 0L
                loop?.cancel(false)
                loop = worker.scheduleWithFixedDelay({ if (running && generation == epoch) tick() }, 0, 1, TimeUnit.SECONDS)
            } catch (_: Exception) {
                main.post { if (generation == epoch) { listener.onStatus("Unable to load enrollment or server address. Check the address, or reset saved enrollment."); running = false } }
            }
        }
    }

    fun stop() {
        pendingStart = null
        val saveSelection = running && !clearingEnrollment
        val savedStorageGeneration = storageGeneration
        val selected = layoutId
        running = false
        generation++
        renderSnapshot = null
        idleLoop?.cancel(false)
        loop?.cancel(false)
        http.dispatcher.cancelAll()
        enqueue {
            socket?.cancel(); socket = null; socketConnecting = false
            if (saveSelection && state.has("identity")) {
                if (selected == null) state.remove("layout_id") else state.put("layout_id", selected)
                runCatching { EnrollmentCleanup.writeIfIdle(app, savedStorageGeneration) { store.write(state) } }
            }
        }
    }

    fun close() {
        if (closed) return
        stop()
        closed = true
        worker.shutdown()
        renderer.shutdown()
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
        main.removeCallbacksAndMessages(null)
    }

    fun refresh() { currentWork { nextSync = 0L; nextCookie = 0L; nextPairPoll = 0L } }

    /** Input activity is local and must never wait for discovery/heartbeat I/O. */
    fun recordActivity() { lastActivity = monotonicTime() }

    fun selectLayout(id: String) {
        recordActivity()
        renderWork { snapshot ->
            try {
                val plan = JSONObject(NativeCore.renderPlan(snapshot.raw, id, null))
                if (plan.has("error") || renderSnapshot !== snapshot || generation != snapshot.epoch) return@renderWork
                layoutId = id; expandedId = null
                persistSelection(id, snapshot.epoch)
                renderAndEmit(snapshot)
            } catch (_: Exception) { ui(snapshot.epoch) { listener.onStatus("Unable to select that layout") } }
        }
    }

    fun expand(cellId: String?) {
        recordActivity()
        renderWork { snapshot ->
            expandedId = cellId
            renderAndEmit(snapshot)
        }
    }

    private fun checkIdle(epoch: Int) {
        val policy = idlePolicy ?: return
        if (!running || generation != epoch || closed || renderSnapshot !== policy.snapshot) return
        if (policy.timeoutMs <= 0 || (!policy.expanded && (!policy.returnToDefault || policy.layout == policy.defaultLayout))) return
        val activity = lastActivity
        if (monotonicTime() - activity < policy.timeoutMs || lastActivity != activity) return
        // Sticky layouts still collapse local fullscreen expansion, but retain
        // their selected layout. Other layouts return to the assigned default.
        val target = if (policy.returnToDefault) policy.defaultLayout else policy.layout
        layoutId = target
        expandedId = null
        persistSelection(target, epoch)
        renderAndEmit(policy.snapshot)
    }

    fun unpair(nextServer: String? = null) {
        if (closed || clearingEnrollment) return
        // Validate before changing enrollment; retain the choice through activity recreation.
        val target = try { nextServer?.let { ServerAddress.parse(it).toString().trimEnd('/') } }
        catch (_: Exception) { status("Enter a valid BF server origin."); return }
        val claim = EnrollmentCleanup.begin(app, UUID.randomUUID().toString())
        val token = claim.token
        clearingEnrollment = true
        stop()
        // Register cleanup outside this Activity's Handler before queueing storage.
        // A joined job may finish now; its claimed token still receives completion.
        continueEnrollmentCleanup(token)
        if (!claim.created) return
        enqueue {
            try {
                val cleared = JSONObject().put(EnrollmentCleanup.MARKER, token).apply { if (target != null) put("server", target) }
                store.write(cleared)
                state = cleared; kioskKey = ""; serverUrl = target.orEmpty(); layoutId = null; expandedId = null
                EnrollmentCleanup.persisted(app, token)
            } catch (error: Exception) {
                EnrollmentCleanup.persisted(app, token, error)
            }
        }
    }

    private fun continueEnrollmentCleanup(token: String) {
        EnrollmentCleanup.request(app, token, clearBrowserSessions) { success ->
            clearingEnrollment = false
            val restart = pendingStart
            pendingStart = null
            if (!closed) {
                if (success) {
                    listener.onPairing("")
                    listener.onStatus("Enrollment cleared. Ready to pair.")
                    if (restart != null) start(restart.server)
                } else listener.onStatus("Unable to clear saved enrollment")
            }
        }
    }

    private fun tick() {
        try {
            ensureActive()
            if (!serverResolved) {
                if (System.currentTimeMillis() < nextSync) return
                operation = "server discovery"
                val resolved = ServerDiscovery.resolve(serverUrl, http, ::ensureActive)
                state.put("server", resolved).put("resolved_server", resolved)
                persist() // Pin the discovered origin before sending any enrollment credentials.
                serverUrl = resolved
                serverResolved = true
                ui(activeEpoch) { listener.onServerAddress(resolved) }
                if (!state.optBoolean("blocked")) emitPlan()
            }
            if (kioskKey.isBlank()) {
                if (System.currentTimeMillis() >= nextPairPoll) { pair(); failures = 0 }
            } else {
                val now = System.currentTimeMillis()
                if (now >= nextSync) {
                    acknowledge()
                    if (heartbeat()) {
                        bundle()
                        if (!state.optBoolean("blocked") && state.has("bundle")) displayCookieIfDue(now)
                    }
                    // An administrator commonly assigns layouts just after
                    // pairing. Keep that setup responsive even without a socket.
                    nextSync = System.currentTimeMillis() + if (awaitingAssignment) 5_000 else 30_000
                    failures = 0
                }
                if (profileVerified && !state.optBoolean("blocked") && socket == null && !socketConnecting && now >= nextSocketAttempt) connectSocket()
            }
        } catch (error: Exception) {
            if (!active()) return
            failures = (failures + 1).coerceAtMost(6)
            val initialConfiguration = kioskKey.isNotBlank() && (!state.has("bundle") || awaitingAssignment)
            val delay = ((2_000L shl failures) + (0..1000).random())
                .coerceAtMost(if (initialConfiguration) 10_000 else 60_000)
            nextSync = System.currentTimeMillis() + delay
            nextPairPoll = System.currentTimeMillis() + delay
            status(when {
                state.optBoolean("blocked") -> state.optString("block_reason", AUTH_REJECTED)
                error is ServerRedirectException -> "BF server returned a redirect. Ask your administrator to fix API routing or use the direct server address."
                error is HttpFailure -> "BF ${error.operation} returned HTTP ${error.code}. Retrying in ${(delay + 999) / 1000}s."
                error is JSONException -> "BF returned invalid data for $operation. Retrying in ${(delay + 999) / 1000}s."
                state.has("bundle") && state.optString("bundle_profile") == VIEWER_PROFILE ->
                    "BF connection unavailable — retaining saved display configuration"
                kioskKey.isNotBlank() -> "BF connection unavailable — no display configuration saved yet. Retrying."
                state.has("pending") -> "BF connection unavailable — retrying pairing. Check the server address and connection."
                else -> "Unable to start pairing with BF. Check the server address and connection. Retrying."
            })
        }
    }

    private class ServerRedirectException : java.io.IOException()
    private class HttpFailure(val operation: String, val code: Int) : java.io.IOException()

    private fun requestOperation(path: String) = when (path) {
        "/api/pair/initiate", "/api/pair/claim" -> "pairing"
        "/api/pair/ack" -> "pairing acknowledgement"
        "/api/kiosk/heartbeat" -> "heartbeat"
        "/api/kiosk/bundle" -> "display configuration"
        "/api/kiosk/display-session" -> "display session"
        else -> "request"
    }

    private fun requireSuccessful(response: Response) {
        if (!response.isSuccessful) throw HttpFailure(requestOperation(response.request.url.encodedPath), response.code)
    }

    private fun rejectRedirect(response: Response) {
        if (response.code in listOf(301, 302, 303, 307, 308)) {
            response.close()
            throw ServerRedirectException()
        }
    }

    private fun request(path: String, body: JSONObject? = null, authenticated: Boolean = true): Response {
        ensureActive()
        operation = requestOperation(path)
        val builder = Request.Builder().url(serverUrl + path)
        if (authenticated) builder.header("Authorization", "Bearer $kioskKey")
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        val response = http.newCall(builder.build()).execute()
        if (!active()) { response.close(); ensureActive() }
        rejectRedirect(response)
        return response
    }

    private fun json(response: Response): JSONObject {
        val body = response.body ?: error("Empty response")
        require(body.contentLength() <= 8 * 1024 * 1024) { "Response too large" }
        val source = body.source()
        require(!source.request(8 * 1024 * 1024L + 1)) { "Response too large" }
        val bytes = source.readByteArray()
        require(bytes.size <= 8 * 1024 * 1024)
        ensureActive()
        return JSONObject(String(bytes, Charsets.UTF_8))
    }

    private fun pair() {
        val now = System.currentTimeMillis()
        if (now < nextPairPoll) return
        var pending = state.optJSONObject("pending")
        if (pending == null) {
            request("/api/pair/initiate", JSONObject().put("proposed_name", "Android ${Build.MODEL}".take(128))
                .put("hardware_model", "${Build.MANUFACTURER} ${Build.MODEL}".take(128))
                .put("capabilities", capabilities()).put("secure_claim", true).put("managed_image", false), false).use {
                requireSuccessful(it)
                pending = json(it)
                require(pending!!.textValue("code") != null && pending!!.textValue("polling_secret") != null)
                state.put("pending", pending); persist()
            }
        }
        val session = pending!!
        ui(activeEpoch) { listener.onPairing(session.getString("code")) }
        nextPairPoll = now + session.optLong("poll_after_ms", 2000).coerceIn(1000, 60_000)
        request("/api/pair/claim", claimBody(session), false).use {
            if (it.code == 429) { nextPairPoll = now + 60_000; return }
            if (it.code != 503) requireSuccessful(it)
            val claim = json(it)
            when (claim.optString("status")) {
                "claimed" -> {
                    require(claim.textValue("kiosk_key") != null && claim.textValue("kiosk_id") != null)
                    require(claim.textValue("encrypt_key") != null || claim.textValue("cluster_key") != null)
                    state.put("identity", claim).put("blocked", false)
                    persist() // Durable identity BEFORE acknowledgement or first bundle fetch.
                    kioskKey = claim.getString("kiosk_key")
                    nextSync = 0L
                    ui(activeEpoch) { listener.onPairing("") }
                    status("Paired — loading assigned display")
                }
                "expired" -> { state.remove("pending"); persist(); nextPairPoll = now + 1000 }
                "revoked", "acknowledged" -> { status("Enrollment unavailable. Reset this display to pair again."); nextPairPoll = now + 60_000 }
            }
        }
    }

    private fun claimBody(pending: JSONObject): JSONObject = JSONObject().put("code", pending.getString("code"))
        .put("polling_secret", pending.getString("polling_secret"))

    private fun acknowledge() {
        val pending = state.optJSONObject("pending") ?: return
        request("/api/pair/ack", claimBody(pending)).use {
            if (it.isSuccessful) { state.remove("pending"); persist() }
        }
    }

    private fun authorized(response: Response): Boolean {
        ensureActive()
        if (response.code == 401 || response.code == 403) {
            blockDisplay(AUTH_REJECTED)
            return false
        }
        requireSuccessful(response)
        return true
    }

    private fun clearCachedBundle() {
        for (key in listOf("bundle", "etag", "bundle_version", "layout_id", "bundle_profile")) state.remove(key)
        layoutId = null; expandedId = null; renderSnapshot = null
    }

    private fun blockDisplay(reason: String) {
        state.put("blocked", true).put("block_reason", reason); persist()
        profileVerified = false
        socket?.cancel(); socket = null; socketConnecting = false
        expandedId = null; renderSnapshot = null; dashboardSessionReady = false; nextCookie = 0L
        ui(activeEpoch) {
            listener.onPlan(JSONObject().put("error", reason))
            WebTile.clearSessions(app)
            listener.onStatus(reason)
        }
    }

    private fun heartbeat(): Boolean {
        val metrics = app.resources.displayMetrics
        val displays = JSONArray().put(JSONObject().put("index", 0).put("name", "Android display")
            .put("width_px", metrics.widthPixels).put("height_px", metrics.heightPixels).put("power_state", "awake"))
        return request("/api/kiosk/heartbeat", JSONObject().put("displays", displays).put("capabilities", capabilities())
            .put("kiosk_app_version", BuildConfig.VERSION_NAME).put("os_version", "Android ${Build.VERSION.RELEASE}")
            .put("bundle_version", state.optString("bundle_version"))).use {
                profileVerified = false
                if (!authorized(it)) return@use false
                // A dropped response body is a transport failure, not evidence
                // that a previously verified server no longer supports viewers.
                val profile = try { json(it).optString("viewer_profile") } catch (_: JSONException) { null }
                ensureActive()
                if (profile != VIEWER_PROFILE) {
                    clearCachedBundle()
                    blockDisplay(PROFILE_REQUIRED)
                    false
                } else {
                    profileVerified = true
                    true
                }
            }
    }

    private fun bundle() {
        check(profileVerified) { "Server viewer profile has not been verified" }
        operation = "display configuration"
        val builder = Request.Builder().url(serverUrl + "/api/kiosk/bundle").header("Authorization", "Bearer $kioskKey")
        state.optString("etag").takeIf { it.isNotBlank() && state.has("bundle") && !state.optBoolean("blocked") }
            ?.let { builder.header("If-None-Match", it) }
        ensureActive()
        http.newCall(builder.build()).execute().use {
            ensureActive()
            rejectRedirect(it)
            if (it.code == 304) {
                status(if (awaitingAssignment) "Connected — waiting for assigned layouts" else "Connected")
                return
            }
            if (it.code == 409) {
                val problem = json(it)
                if (problem.optString("error") == "display_unassigned") {
                    clearCachedBundle()
                    awaitingAssignment = true
                    state.put("blocked", false).remove("block_reason")
                    persist()
                    ui(activeEpoch) { listener.onPlan(JSONObject().put("error", NO_LAYOUTS_ASSIGNED)) }
                    status("Connected — waiting for assigned layouts")
                    return
                }
            }
            if (!authorized(it)) return
            val bundle = json(it)
            val raw = bundle.toString()
            val plan = JSONObject(NativeCore.renderPlan(raw, null, null))
            awaitingAssignment = plan.optString("error") == NO_LAYOUTS_ASSIGNED
            if (plan.has("error")) {
                state.put("bundle", raw).put("bundle_version", bundle.optString("version"))
                    .put("etag", it.header("ETag") ?: "").put("blocked", false).put("bundle_profile", VIEWER_PROFILE)
                state.remove("block_reason")
                persist()
                emitPlan()
                status(if (awaitingAssignment) "Connected — waiting for assigned layouts" else "Connected — display configuration needs attention")
                return
            }
            val changed = raw != state.optString("bundle") || state.optBoolean("blocked")
            state.put("bundle", raw).put("bundle_version", bundle.optString("version"))
                .put("etag", it.header("ETag") ?: "").put("blocked", false).put("bundle_profile", VIEWER_PROFILE)
            state.remove("block_reason")
            persist()
            if (changed) emitPlan()
            status("Connected")
        }
    }

    private fun displayCookieIfDue(now: Long): Boolean {
        if (now < nextCookie) return true
        request("/api/kiosk/display-session", JSONObject()).use { response ->
            if (response.code == 401 || response.code == 403) { authorized(response); return false }
            if (!response.isSuccessful) { nextCookie = now + 60_000; return true }
            val cookies = response.headers.values("Set-Cookie")
            if (cookies.isEmpty()) { nextCookie = now + 60_000; return true }
            val epoch = activeEpoch
            val origin = serverUrl
            val latch = CountDownLatch(cookies.size)
            val accepted = java.util.concurrent.atomic.AtomicBoolean(true)
            main.post {
                if (!running || generation != epoch || closed) {
                    repeat(cookies.size) { latch.countDown() }
                    accepted.set(false)
                    return@post
                }
                try {
                    val manager = CookieManager.getInstance()
                    cookies.forEach { cookie ->
                        manager.setCookie(origin, cookie) { success ->
                            if (!success) accepted.set(false)
                            latch.countDown()
                        }
                    }
                } catch (_: Exception) {
                    accepted.set(false)
                    repeat(cookies.size) { latch.countDown() }
                }
            }
            // CookieManager writes asynchronously. Never load a dashboard before its session is installed.
            val ready = latch.await(5, TimeUnit.SECONDS) && accepted.get()
            ensureActive()
            val wasReady = dashboardSessionReady
            dashboardSessionReady = ready
            nextCookie = System.currentTimeMillis() + if (ready) 30 * 60_000 else 60_000
            if (wasReady != ready) emitPlan()
        }
        return true
    }

    private fun emitPlan() {
        if (!active() || state.optBoolean("blocked") || state.optString("bundle_profile") != VIEWER_PROFILE) return
        val raw = state.optString("bundle").takeIf { it.isNotBlank() } ?: return
        val identity = state.optJSONObject("identity") ?: JSONObject()
        val encryptKey = identity.textValue("encrypt_key") ?: identity.textValue("cluster_key")
        renderSnapshot = RenderSnapshot(raw, serverUrl, encryptKey, dashboardSessionReady, activeEpoch)
        renderWork(::renderAndEmit)
    }

    private fun renderAndEmit(snapshot: RenderSnapshot) {
        try {
            var plan = JSONObject(NativeCore.renderPlan(snapshot.raw, layoutId, expandedId))
            var resetSelection = false
            if (plan.has("error") && layoutId != null) {
                plan = JSONObject(NativeCore.renderPlan(snapshot.raw, null, null))
                resetSelection = !plan.has("error")
            }
            if (renderSnapshot !== snapshot || !running || generation != snapshot.epoch) return
            if (plan.has("error")) {
                idlePolicy = null
                ui(snapshot.epoch) { if (renderSnapshot === snapshot) listener.onPlan(plan) }
                return
            }
            if (resetSelection) { layoutId = null; persistSelection(null, snapshot.epoch) }
            expandedId = plan.textValue("expandedCellId")
            idlePolicy = IdlePolicy(snapshot, plan.optLong("idleTimeoutSeconds").coerceAtLeast(0) * 1000,
                plan.getString("layoutId"), plan.optString("idleReturnLayoutId", plan.getString("layoutId")),
                plan.optBoolean("resetsIdleTimer"), expandedId != null)
            fun enrich(cells: JSONArray?) {
                if (cells == null) return
                for (index in 0 until cells.length()) {
                    val cell = cells.getJSONObject(index)
                    val camera = cell.optJSONObject("camera")
                    if (camera != null) {
                        val username = camera.optString("username").takeIf { it.isNotBlank() && it != "null" }
                        val encrypted = camera.optString("encryptedPassword").takeIf { it.isNotBlank() && it != "null" }
                        for (name in listOf("uri", "fallbackUri")) camera.optString(name).takeIf { it.isNotBlank() && it != "null" }?.let { value ->
                            val resolved = NativeCore.cameraUri(value, username, encrypted, snapshot.encryptKey)
                            camera.put(name, resolved ?: JSONObject.NULL)
                        }
                        camera.remove("username"); camera.remove("encryptedPassword")
                        if (camera.isNull("uri")) {
                            cell.put("kind", "placeholder").put("camera", JSONObject.NULL)
                                .put("message", "Camera playback credentials are unavailable")
                        }
                    }
                    cell.optJSONObject("web")?.let { web ->
                        web.optString("url").takeIf { it.isNotBlank() && it != "null" }?.let { value ->
                            val resolved = NativeCore.resolveWebUrl(value, snapshot.server)
                            web.put("url", resolved ?: JSONObject.NULL)
                            if (resolved == null) {
                                cell.put("kind", "placeholder").put("web", JSONObject.NULL).put("message", "Unsupported web address")
                            } else if (WebTile.origin(resolved) == WebTile.origin(snapshot.server) && !snapshot.cookieReady) {
                                cell.put("kind", "placeholder").put("web", JSONObject.NULL)
                                    .put("message", "Waiting for an authenticated display session")
                            }
                        }
                    }
                }
            }
            enrich(plan.optJSONArray("cells"))
            ui(snapshot.epoch) { if (renderSnapshot === snapshot) listener.onPlan(plan) }
        } catch (_: Exception) { ui(snapshot.epoch) { listener.onStatus("Assigned layout cannot be rendered on this device") } }
    }

    private fun connectSocket() {
        val epoch = generation
        val url = NativeCore.websocketUrl(serverUrl, kioskKey) ?: return
        socketConnecting = true
        nextSocketAttempt = System.currentTimeMillis() + 30_000
        socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                enqueue {
                    if (epoch != generation || !running || socket !== webSocket) webSocket.cancel()
                    else socketConnecting = false
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > 64 * 1024 || epoch != generation || !running) return
                enqueue {
                    if (epoch != generation || !running || socket !== webSocket) return@enqueue
                    try {
                        val command = JSONObject(text)
                        when (command.optString("type")) {
                            "ping" -> webSocket.send("{\"type\":\"pong\"}")
                            "reload-bundle" -> nextSync = 0L
                            "layout-switch" -> {
                                val raw = state.optString("bundle")
                                val display = JSONObject(NativeCore.renderPlan(raw, layoutId, null)).optString("displayId")
                                val target = command.optString("display_id").takeUnless { it.isBlank() || it == "null" }
                                if (display.isNotBlank() && (target == null || target == display)) selectLayout(command.get("layout_id").toString())
                            }
                            else -> Unit // No device/management commands are executed.
                        }
                    } catch (_: Exception) { /* Ignore invalid server messages. */ }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = disconnected(webSocket)
            private fun disconnected(webSocket: WebSocket) { enqueue {
                if (epoch == generation && socket === webSocket) { socket = null; socketConnecting = false; nextSocketAttempt = System.currentTimeMillis() + 10_000 + (0..3000).random() }
            } }
        })
    }

    private fun capabilities() = JSONArray(listOf("android", "android-viewer", "android-viewer-v1", "rtsp", "web", "html", "touch", "dpad"))
}
