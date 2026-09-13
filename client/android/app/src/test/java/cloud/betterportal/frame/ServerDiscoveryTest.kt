package cloud.betterportal.frame

import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ServerDiscoveryTest {
    private fun client(respond: (Request) -> Pair<Int, String?>) = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).addInterceptor { chain ->
            val request = chain.request()
            assertEquals("GET", request.method)
            assertEquals("/healthz", request.url.encodedPath)
            assertNull(request.body)
            assertNull(request.header("Authorization"))
            assertNull(request.header("Cookie"))
            val (code, location) = respond(request)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("fixture")
                .body("".toResponseBody()).apply { location?.let { header("Location", it) } }.build()
        }.build()

    @Test fun discoversRegionalOriginWithAnonymousRequests() {
        val visited = mutableListOf<String>()
        val http = client { request ->
            visited.add(request.url.host)
            if (request.url.host == "frame.betterportal.net") 307 to "https://frame-eu.betterportal.net/healthz"
            else 200 to null
        }
        assertEquals("https://frame-eu.betterportal.net", ServerDiscovery.resolve(ServerAddress.DEFAULT, http))
        assertEquals(listOf("frame.betterportal.net", "frame-eu.betterportal.net"), visited)
    }

    @Test fun rejectsUnsafeMalformedAndLoopingTargetsWithoutRequestingThem() {
        for (target in listOf(null, "http://frame-eu.betterportal.net/healthz", "http://127.0.0.1/healthz",
            "https://user:secret@frame-eu.betterportal.net/healthz", "https://frame-eu.betterportal.net/login",
            "https://frame-eu.betterportal.net/healthz?token=secret", "https://frame-eu.betterportal.net/healthz#fragment",
            "file:///healthz", "/healthz")) {
            var calls = 0
            val http = client { calls++; 307 to target }
            assertThrows("Accepted redirect: $target", IOException::class.java) { ServerDiscovery.resolve(ServerAddress.DEFAULT, http) }
            assertEquals(1, calls)
        }
    }

    @Test fun boundsRedirectChainAndAcceptsFiveHops() {
        for (finish in listOf(false, true)) {
            var calls = 0
            val http = client {
                calls++
                if (finish && calls == 6) 200 to null else 308 to "https://region$calls.example/"
            }
            if (finish) assertEquals("https://region5.example", ServerDiscovery.resolve(ServerAddress.DEFAULT, http))
            else assertThrows(IOException::class.java) { ServerDiscovery.resolve(ServerAddress.DEFAULT, http) }
            assertEquals(6, calls)
        }
    }

    @Test fun directLocalApiRemainsSupportedWithoutHealthEndpoint() {
        assertEquals("http://192.168.1.5:18081", ServerDiscovery.resolve("http://192.168.1.5:18081", client { 404 to null }))
        assertThrows(IOException::class.java) {
            ServerDiscovery.resolve("http://192.168.1.5:18081", client { 307 to "http://192.168.1.6/healthz" })
        }
        assertThrows(IOException::class.java) { ServerDiscovery.resolve(ServerAddress.DEFAULT, client { 503 to null }) }
    }
}
