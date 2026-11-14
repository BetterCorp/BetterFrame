package cloud.betterportal.frame

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

class TrustedCaPolicyTest {
    private fun certificate(): JSONObject {
        val directory = Files.createTempDirectory("bf-ca-unit").toFile()
        try {
            val process = ProcessBuilder("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=BF Android unit test", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", directory.resolve("key").path, "-out", directory.resolve("cert").path).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start()
            check(process.waitFor() == 0)
            val pem = directory.resolve("cert").readText()
            val cert = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
            return JSONObject().put("pem", pem).put("fingerprint_sha256", TrustedCaPolicy.fingerprint(cert.encoded))
        } finally { directory.deleteRecursively() }
    }
    private class Store {
        var saved = "{}"
        var owner = true
        var failAdd = false
        val installed = mutableSetOf<String>()
        fun sync(cas: JSONArray) = TrustedCaPolicy.sync(cas, { JSONObject(saved) }, { owner }, { installed.toSet() },
            { cert -> installed.add(TrustedCaPolicy.fingerprint(cert.encoded)); if (failAdd) error("interrupted install") },
            { der -> installed.remove(TrustedCaPolicy.fingerprint(der)); Unit }, { saved = it.toString() })
    }
    @Test fun managedInstallIsIdempotentAndOnlyRemovesOwnedRoots() {
        val ca = certificate(); val fp = ca.getString("fingerprint_sha256")
        val store = Store(); store.installed.add("external")
        assertEquals("applied", store.sync(JSONArray().put(ca)).getString("state"))
        assertTrue(store.installed.contains(fp)); assertFalse(store.sync(JSONArray().put(ca)).getBoolean("changed"))
        assertTrue(store.sync(JSONArray()).getBoolean("changed"))
        assertEquals(setOf("external"), store.installed)
        val preexisting = Store(); preexisting.installed.add(fp)
        preexisting.sync(JSONArray().put(ca)); preexisting.sync(JSONArray())
        assertTrue(preexisting.installed.contains(fp))
    }
    @Test fun interruptedInstallationRetainsOwnershipAndRecoversThroughRemoval() {
        val ca = certificate(); val store = Store(); store.failAdd = true
        assertEquals("error", store.sync(JSONArray().put(ca)).getString("state"))
        assertTrue(JSONObject(store.saved).getJSONObject("owned").has(ca.getString("fingerprint_sha256")))
        store.failAdd = false
        assertEquals("applied", store.sync(JSONArray()).getString("state"))
        assertTrue(store.installed.isEmpty())
    }
    @Test fun unmanagedDevicesReportManualInstallAndManualRemovalUntilConfirmed() {
        val ca = certificate(); val fp = ca.getString("fingerprint_sha256"); val store = Store(); store.owner = false
        assertEquals("manual_action", store.sync(JSONArray().put(ca)).getString("state"))
        store.installed.add(fp)
        assertEquals("applied", store.sync(JSONArray().put(ca)).getString("state"))
        assertEquals("manual_action", store.sync(JSONArray()).getString("state"))
        assertTrue(store.installed.contains(fp))
        store.installed.remove(fp)
        assertEquals("applied", store.sync(JSONArray()).getString("state"))
    }
    @Test fun invalidAssignmentsCannotChangeExistingTrust() {
        val ca = certificate(); val store = Store()
        store.sync(JSONArray().put(ca))
        val previous = store.saved
        val invalid = JSONObject(ca.toString()).put("fingerprint_sha256", "0".repeat(64))
        assertEquals("error", store.sync(JSONArray().put(invalid)).getString("state"))
        assertEquals(previous, store.saved)
        assertEquals("error", store.sync(JSONArray().put(ca).put(ca)).getString("state"))
        assertEquals(previous, store.saved)
    }
}
