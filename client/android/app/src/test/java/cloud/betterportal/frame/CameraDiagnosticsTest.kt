package cloud.betterportal.frame

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class CameraDiagnosticsTest {
    @Test fun retainsNestedCauseAndNetworkCategoryWithoutSecrets() {
        val error = IOException("rtsp://alice:secret@camera/live?token=private",
            SocketTimeoutException("password=secret"))
        val result = CameraDiagnostics.causes(error)
        assertTrue(result.contains("IOException"))
        assertTrue(result.contains("SocketTimeoutException[socket_timeout]"))
        for (secret in listOf("alice", "secret", "private", "rtsp://", "password=")) {
            assertFalse(result.contains(secret))
        }
    }

    @Test fun retainsOnlyStrictRtspStatusMessages() {
        assertTrue(CameraDiagnostics.causes(IOException("DESCRIBE 401")).contains("[DESCRIBE 401]"))
        assertFalse(CameraDiagnostics.causes(IOException("DESCRIBE 401 token=secret")).contains("DESCRIBE"))
        assertFalse(CameraDiagnostics.causes(IOException("Authorization: Basic abcdef")).contains("abcdef"))
    }

    @Test fun boundsCyclesAndDeepChains() {
        val first = IOException("first")
        val second = IOException("second", first)
        first.initCause(second)
        assertTrue(CameraDiagnostics.causes(first).endsWith("[cause chain truncated]"))
        var deep: Throwable = IOException("leaf")
        repeat(30) { deep = IOException("parent", deep) }
        val result = CameraDiagnostics.causes(deep)
        assertTrue(result.length <= 4096)
        assertEquals(8, Regex("IOException").findAll(result).count())
    }

    @Test fun rejectsUnsafeIdentifiers() {
        assertEquals("42", CameraDiagnostics.identifier("42"))
        assertEquals("cam-abc_1", CameraDiagnostics.identifier("cam-abc_1"))
        assertEquals("unknown", CameraDiagnostics.identifier("rtsp://user:pass@host"))
        assertEquals("unknown", CameraDiagnostics.identifier("42\nforged log"))
        assertEquals("unknown", CameraDiagnostics.identifier("x".repeat(65)))
    }
}
