package cloud.betterportal.frame

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/** Pure reconciliation policy; the Android adapter supplies storage and device-owner APIs. */
internal object TrustedCaPolicy {
    fun fingerprint(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun parse(item: JSONObject): X509Certificate {
        val pem = item.getString("pem")
        require(pem.toByteArray().size <= 16384 && Regex("-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----").matches(pem.trim())) { "Invalid CA certificate" }
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
        require(cert.basicConstraints >= 0 && cert.subjectX500Principal == cert.issuerX500Principal) { "A self-signed root CA is required" }
        cert.verify(cert.publicKey); cert.checkValidity()
        require(fingerprint(cert.encoded) == item.getString("fingerprint_sha256")) { "CA fingerprint mismatch" }
        return cert
    }

    fun sync(cas: JSONArray, read: () -> JSONObject, owner: () -> Boolean, installed: () -> Set<String>,
             install: (X509Certificate) -> Unit, remove: (ByteArray) -> Unit, persist: (JSONObject) -> Unit): JSONObject {
        var revision = fingerprint((0 until cas.length()).mapNotNull { cas.optJSONObject(it)?.optString("fingerprint_sha256") }.sorted().joinToString("\n").toByteArray())
        try {
            require(cas.length() <= 32) { "At most 32 CA certificates are supported" }
            val desired = linkedMapOf<String, X509Certificate>()
            for (i in 0 until cas.length()) {
                val item = cas.getJSONObject(i)
                val cert = parse(item)
                require(desired.put(item.getString("fingerprint_sha256"), cert) == null) { "Duplicate CA" }
            }
            revision = fingerprint(desired.keys.sorted().joinToString("\n").toByteArray())
            val state = read()
            val owned = state.optJSONObject("owned") ?: JSONObject()
            val previous = state.optJSONObject("previous") ?: JSONObject()
            val managed = owner()
            val present = installed()
            var manual = false
            var changed = state.optBoolean("dirty")
            fun journal() { state.put("owned", owned).put("dirty", true); persist(state) }
            for (fp in owned.keys().asSequence().toList()) {
                if (desired.containsKey(fp)) continue
                if (managed) {
                    val der = Base64.getDecoder().decode(owned.getString(fp))
                    require(fingerprint(der) == fp) { "Corrupt CA ownership journal" }
                    journal(); remove(der); changed = true
                    owned.remove(fp); journal()
                } else if (present.contains(fp)) manual = true
                else { owned.remove(fp); journal() }
            }
            for ((fp, cert) in desired) {
                if (present.contains(fp)) continue
                if (!managed) { manual = true; continue }
                owned.put(fp, Base64.getEncoder().encodeToString(cert.encoded))
                journal(); install(cert); changed = true
            }
            if (!managed) {
                for (fp in previous.keys().asSequence().toList()) {
                    if (!desired.containsKey(fp) && present.contains(fp)) manual = true
                    else if (!desired.containsKey(fp)) previous.remove(fp)
                }
            } else for (fp in previous.keys().asSequence().toList()) if (!desired.containsKey(fp)) previous.remove(fp)
            desired.keys.forEach { previous.put(it, true) }
            state.put("previous", previous).put("owned", owned).put("dirty", false); persist(state)
            return JSONObject().put("revision", revision).put("state", if (manual) "manual_action" else "applied").put("changed", changed)
                .put("message", if (manual) "Install assigned CAs or remove previously assigned CAs through Android Settings. Download certificates from BetterFrame’s Trusted CAs page." else "")
        } catch (error: Exception) {
            return JSONObject().put("revision", revision).put("state", "error").put("changed", false)
                .put("message", (error.message ?: "CA provisioning failed").take(1024))
        }
    }
}
