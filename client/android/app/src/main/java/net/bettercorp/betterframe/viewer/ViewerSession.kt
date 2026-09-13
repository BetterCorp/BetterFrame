package net.bettercorp.betterframe.viewer

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Outbound display client only. All network/storage work is serialized away from the UI. */
class ViewerSession(context: Context, private val listener: Listener) {
    interface Listener {
        fun onStatus(message: String)
        fun onPairing(code: String)
        fun onPlan(plan: JSONObject)
    }
    private val app = context.applicationContext
    private val store = ProtectedStore(app)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    private var state = JSONObject()
    private var loop: ScheduledFuture<*>? = null
    private var socket: WebSocket? = null
    private var socketConnecting = false
    private var nextSocketAttempt = 0L
    private var nextSync = 0L
    private var nextCookie = 0L
    private var nextPairPoll = 0L
    private var failures = 0
    private var layoutId: String? = null
    private var expandedId: String? = null
    @Volatile private var generation = 0
    @Volatile private var running = false
    @Volatile var serverUrl: String = ""
        private set
    @Volatile var kioskKey: String = ""
        private set

    private fun ui(epoch: Int = generation, action: () -> Unit) {
        main.post { if (running && generation == epoch) action() }
    }
    private fun status(message: String) = ui { listener.onStatus(message) }

    fun start(serverUrl: String? = null) {
        if (running) { if (serverUrl != null && serverUrl.trimEnd('/') != this.serverUrl) status("Unpair before changing the BF server"); return }
        running = true
        val epoch = ++generation
        worker.execute {
            if (generation != epoch || !running) return@execute
            try {
                state = store.read()
                val saved = state.optString("server")
                val chosen = serverUrl?.takeIf { it.isNotBlank() } ?: saved
                if (chosen.isBlank()) {
                    main.post { if (generation == epoch) { listener.onStatus("Enter the BF server address to pair this display"); running = false } }
                    return@execute
                }
                val origin = ServerAddress.parse(chosen).toString().trimEnd('/')
                require(saved.isBlank() || saved == origin) { "Unpair before changing the BF server" }
                this.serverUrl = origin
                state.put("server", origin)
                kioskKey = state.optJSONObject("identity")?.optString("kiosk_key") ?: ""
                layoutId = state.optString("layout_id").takeIf { it.isNotBlank() }
                store.write(state)
                if (!state.optBoolean("blocked")) emitPlan()
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
        running = false
        generation++
        loop?.cancel(false)
        http.dispatcher.cancelAll()
        worker.execute { socket?.cancel(); socket = null; socketConnecting = false }
    }

    fun close() { stop(); worker.shutdown() }

    fun refresh() { worker.execute { nextSync = 0L; nextCookie = 0L; nextPairPoll = 0L } }

    fun selectLayout(id: String) = worker.execute {
        val raw = state.optString("bundle").takeIf { it.isNotBlank() } ?: return@execute
        try {
            val plan = JSONObject(NativeCore.renderPlan(raw, id, null))
            val layouts = plan.optJSONArray("layouts") ?: JSONArray()
            if ((0 until layouts.length()).none { layouts.getJSONObject(it).optString("id") == id }) return@execute
            layoutId = id; expandedId = null
            state.put("layout_id", id); store.write(state); emitPlan()
        } catch (_: Exception) { status("Unable to select that layout") }
    }

    fun expand(cellId: String?) = worker.execute { expandedId = cellId; emitPlan() }

    fun unpair() {
        stop()
        worker.execute {
            store.clear(); state = JSONObject(); kioskKey = ""; serverUrl = ""; layoutId = null; expandedId = null
            main.post { WebTile.clearSessions(app); listener.onPairing(""); listener.onStatus("Enrollment cleared. Enter the BF server address.") }
        }
    }

    private fun tick() {
        try {
            if (kioskKey.isBlank()) pair()
            else {
                val now = System.currentTimeMillis()
                if (now >= nextSync) {
                    acknowledge()
                    heartbeat()
                    if (now >= nextCookie && !state.optBoolean("blocked")) displayCookie()
                    bundle()
                    nextSync = now + 30_000
                }
                if (!state.optBoolean("blocked") && socket == null && !socketConnecting && now >= nextSocketAttempt) connectSocket()
            }
            failures = 0
        } catch (_: Exception) {
            failures = (failures + 1).coerceAtMost(6)
            val delay = (2_000L shl failures).coerceAtMost(60_000) + (0..1000).random()
            nextSync = System.currentTimeMillis() + delay
            nextPairPoll = System.currentTimeMillis() + delay
            status("BF connection unavailable — retaining saved display configuration")
        }
    }

    private fun request(path: String, body: JSONObject? = null, authenticated: Boolean = true): Response {
        val builder = Request.Builder().url(serverUrl + path)
        if (authenticated) builder.header("Authorization", "Bearer $kioskKey")
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        return http.newCall(builder.build()).execute()
    }

    private fun json(response: Response): JSONObject {
        val body = response.body ?: error("Empty response")
        require(body.contentLength() <= 8 * 1024 * 1024) { "Response too large" }
        val source = body.source()
        require(!source.request(8 * 1024 * 1024L + 1)) { "Response too large" }
        val bytes = source.readByteArray()
        require(bytes.size <= 8 * 1024 * 1024)
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
                check(it.isSuccessful)
                pending = json(it)
                require(pending!!.optString("code").isNotBlank() && pending!!.optString("polling_secret").isNotBlank())
                state.put("pending", pending); store.write(state)
            }
        }
        val session = pending!!
        ui { listener.onPairing(session.getString("code")) }
        nextPairPoll = now + session.optLong("poll_after_ms", 2000).coerceIn(1000, 60_000)
        request("/api/pair/claim", claimBody(session), false).use {
            if (it.code == 429) { nextPairPoll = now + 60_000; return }
            check(it.isSuccessful || it.code == 503)
            val claim = json(it)
            when (claim.optString("status")) {
                "claimed" -> {
                    require(claim.optString("kiosk_key").isNotBlank() && claim.optString("kiosk_id").isNotBlank())
                    require(claim.optString("encrypt_key").isNotBlank() || claim.optString("cluster_key").isNotBlank())
                    state.put("identity", claim).put("blocked", false)
                    store.write(state) // Durable identity BEFORE acknowledgement or first bundle fetch.
                    kioskKey = claim.getString("kiosk_key")
                    nextSync = 0L
                    ui { listener.onPairing("") }
                    status("Paired — loading assigned display")
                }
                "expired" -> { state.remove("pending"); store.write(state); nextPairPoll = now + 1000 }
                "revoked", "acknowledged" -> { status("Enrollment unavailable. Reset this display to pair again."); nextPairPoll = now + 60_000 }
            }
        }
    }

    private fun claimBody(pending: JSONObject): JSONObject = JSONObject().put("code", pending.getString("code"))
        .put("polling_secret", pending.getString("polling_secret"))

    private fun acknowledge() {
        val pending = state.optJSONObject("pending") ?: return
        request("/api/pair/ack", claimBody(pending)).use {
            if (it.isSuccessful) { state.remove("pending"); store.write(state) }
        }
    }

    private fun authorized(response: Response): Boolean {
        if (response.code == 401 || response.code == 403) {
            state.put("blocked", true); store.write(state)
            socket?.cancel(); socket = null
            ui { listener.onPlan(JSONObject().put("cells", JSONArray())); listener.onStatus("Display authorization rejected. Check this device in BF.") }
            return false
        }
        check(response.isSuccessful)
        return true
    }

    private fun heartbeat() {
        val metrics = app.resources.displayMetrics
        val displays = JSONArray().put(JSONObject().put("index", 0).put("name", "Android display")
            .put("width_px", metrics.widthPixels).put("height_px", metrics.heightPixels).put("power_state", "on"))
        request("/api/kiosk/heartbeat", JSONObject().put("displays", displays).put("capabilities", capabilities())
            .put("kiosk_app_version", BuildConfig.VERSION_NAME).put("os_version", "Android ${Build.VERSION.RELEASE}")
            .put("bundle_version", state.optString("bundle_version"))).use { authorized(it) }
    }

    private fun bundle() {
        val builder = Request.Builder().url(serverUrl + "/api/kiosk/bundle").header("Authorization", "Bearer $kioskKey")
        state.optString("etag").takeIf { it.isNotBlank() && state.has("bundle") && !state.optBoolean("blocked") }
            ?.let { builder.header("If-None-Match", it) }
        http.newCall(builder.build()).execute().use {
            if (it.code == 304) { status("Connected"); return }
            if (!authorized(it)) return
            val bundle = json(it)
            val raw = bundle.toString()
            var plan = JSONObject(NativeCore.renderPlan(raw, layoutId, expandedId))
            if (plan.has("error") && layoutId != null) {
                plan = JSONObject(NativeCore.renderPlan(raw, null, null))
                if (!plan.has("error")) { layoutId = null; expandedId = null; state.remove("layout_id") }
            }
            if (plan.has("error")) {
                ui { listener.onPlan(plan) }
                status("Assign one supported display layout to this device in BF")
                return
            }
            val changed = raw != state.optString("bundle") || state.optBoolean("blocked")
            state.put("bundle", raw).put("bundle_version", bundle.optString("version"))
                .put("etag", it.header("ETag") ?: "").put("blocked", false)
            store.write(state)
            if (changed) emitPlan()
            status("Connected")
        }
    }

    private fun displayCookie() {
        request("/api/kiosk/display-session", JSONObject()).use { response ->
            if (!response.isSuccessful) { nextCookie = System.currentTimeMillis() + 60_000; return }
            val cookies = response.headers.values("Set-Cookie")
            val origin = serverUrl
            ui { cookies.forEach { CookieManager.getInstance().setCookie(origin, it) }; CookieManager.getInstance().flush() }
            nextCookie = System.currentTimeMillis() + 30 * 60_000
        }
    }

    private fun emitPlan() {
        if (!running || state.optBoolean("blocked")) return
        val raw = state.optString("bundle").takeIf { it.isNotBlank() } ?: return
        try {
            val plan = JSONObject(NativeCore.renderPlan(raw, layoutId, expandedId))
            val identity = state.optJSONObject("identity") ?: JSONObject()
            val encryptKey = identity.optString("encrypt_key").takeIf { it.isNotBlank() && it != "null" }
                ?: identity.optString("cluster_key").takeIf { it.isNotBlank() && it != "null" }
            fun enrich(cells: JSONArray?) {
                if (cells == null) return
                for (index in 0 until cells.length()) {
                    val cell = cells.getJSONObject(index)
                    val camera = cell.optJSONObject("camera")
                    if (camera != null) {
                        val username = camera.optString("username").takeIf { it.isNotBlank() && it != "null" }
                        val encrypted = camera.optString("encryptedPassword").takeIf { it.isNotBlank() && it != "null" }
                        for (name in listOf("uri", "fallbackUri")) camera.optString(name).takeIf { it.isNotBlank() && it != "null" }?.let { value ->
                            val resolved = NativeCore.cameraUri(value, username, encrypted, encryptKey)
                            camera.put(name, resolved ?: JSONObject.NULL)
                        }
                        camera.remove("username"); camera.remove("encryptedPassword")
                    }
                    cell.optJSONObject("web")?.let { web ->
                        web.optString("url").takeIf { it.isNotBlank() && it != "null" }?.let { value ->
                            web.put("url", NativeCore.resolveWebUrl(value, serverUrl) ?: JSONObject.NULL)
                        }
                    }
                }
            }
            enrich(plan.optJSONArray("cells"))
            plan.optJSONObject("layout")?.let { enrich(it.optJSONArray("cells")) }
            ui { listener.onPlan(plan) }
        } catch (_: Exception) { status("Assigned layout cannot be rendered on this device") }
    }

    private fun connectSocket() {
        val epoch = generation
        val url = NativeCore.websocketUrl(serverUrl, kioskKey) ?: return
        socketConnecting = true
        nextSocketAttempt = System.currentTimeMillis() + 30_000
        socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { worker.execute { socketConnecting = false; if (epoch != generation) webSocket.cancel() } }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > 64 * 1024 || epoch != generation || !running) return
                worker.execute {
                    if (epoch != generation || !running) return@execute
                    try {
                        val command = JSONObject(text)
                        when (command.optString("type")) {
                            "ping" -> webSocket.send("{\"type\":\"pong\"}")
                            "reload-bundle" -> nextSync = 0L
                            "layout-switch" -> selectLayout(command.get("layout_id").toString())
                            else -> Unit // No device/management commands are executed.
                        }
                    } catch (_: Exception) { /* Ignore invalid server messages. */ }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = disconnected(webSocket)
            private fun disconnected(webSocket: WebSocket) { worker.execute {
                if (socket === webSocket) { socket = null; socketConnecting = false; nextSocketAttempt = System.currentTimeMillis() + 10_000 + (0..3000).random() }
            } }
        })
    }

    private fun capabilities() = JSONArray(listOf("android", "android-viewer", "android-viewer-v1", "rtsp", "web", "html", "touch", "dpad"))
}
