package net.bettercorp.betterframe.viewer

import org.junit.Assert.*
import org.junit.Test

class ServerAddressTest {
    @Test fun acceptsHttpsAndExplicitLocalHttp() {
        assertEquals("https://bf.example/", ServerAddress.parse("https://bf.example").toString())
        assertEquals("http://192.168.1.5:18081/", ServerAddress.parse("http://192.168.1.5:18081").toString())
        assertTrue(ServerAddress.isLocalHost("172.16.2.3"))
        assertFalse(ServerAddress.isLocalHost("172.160.2.3"))
        assertFalse(ServerAddress.isLocalHost("192.168.1.500"))
    }
    @Test fun rejectsCredentialBearingUrlsAndRemoteCleartext() {
        listOf("http://example.com", "https://user:secret@bf.example", "https://bf.example/admin", "https://bf.example/?token=secret").forEach {
            try { ServerAddress.parse(it); fail("Accepted invalid server URL") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun acceptsPrivateAndLinkLocalIpv6WithoutAllowingPublicCleartext() {
        listOf("fc00::1", "fd00::10", "FDFF:FFFF::1", "fe80::1", "febf:ffff::1", "0:0:0:0:0:0:0:1").forEach { host ->
            assertTrue("Local IPv6 literal rejected: $host", ServerAddress.isLocalHost(host))
            assertEquals(18081, ServerAddress.parse("http://[$host]:18081").port)
        }
        listOf("fbff::1", "fe00::1", "fec0::1", "2001:db8::10", "ff02::1", "::").forEach { host ->
            assertFalse("Non-local IPv6 literal accepted: $host", ServerAddress.isLocalHost(host))
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.parse("http://[$host]:18081") }
        }
        assertFalse(ServerAddress.isLocalHost("fd00::not-an-address"))
        assertTrue(ServerAddress.parse("https://[2001:db8::10]").isHttps)
    }
}
