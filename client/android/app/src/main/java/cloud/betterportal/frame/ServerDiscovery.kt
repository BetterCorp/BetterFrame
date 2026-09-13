package cloud.betterportal.frame

import okhttp3.OkHttpClient
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.Request
import java.io.IOException

/** Resolve the public entrypoint without sending enrollment or device credentials. */
object ServerDiscovery {
    private val redirects = setOf(301, 302, 303, 307, 308)
    private const val MAX_REDIRECTS = 5

    fun resolve(origin: String, http: OkHttpClient, ensureActive: () -> Unit = {}): String {
        require(!http.followRedirects && !http.followSslRedirects) { "Discovery requires manual redirects" }
        val anonymous = http.newBuilder().cookieJar(CookieJar.NO_COOKIES)
            .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE).build()
        var current = ServerAddress.parse(origin)
        val visited = mutableSetOf(current)
        repeat(MAX_REDIRECTS + 1) { hop ->
            ensureActive()
            val probe = current.newBuilder().encodedPath("/healthz").build()
            // This separate request deliberately has no body, Authorization, or cookies.
            anonymous.newCall(Request.Builder().url(probe).get().build()).execute().use { response ->
                ensureActive()
                if (response.code !in redirects) {
                    // Direct API listeners predate /healthz; a 404 preserves their support.
                    if (!response.isSuccessful && response.code != 404) throw IOException("Server discovery unavailable")
                    return current.toString().trimEnd('/')
                }
                if (hop == MAX_REDIRECTS) throw IOException("Too many server redirects")
                val target = response.header("Location")?.let(probe::resolve)
                    ?: throw IOException("Invalid server redirect")
                if (!target.isHttps || target.username.isNotEmpty() || target.password.isNotEmpty() ||
                    target.query != null || target.fragment != null || target.encodedPath !in setOf("/", "/healthz")) {
                    throw IOException("Server redirect must identify a secure BF origin")
                }
                val next = ServerAddress.parse(target.newBuilder().encodedPath("/").build().toString())
                if (!visited.add(next)) throw IOException("Server redirect loop")
                current = next
            }
        }
        throw IOException("Too many server redirects")
    }
}
