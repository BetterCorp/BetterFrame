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
}
