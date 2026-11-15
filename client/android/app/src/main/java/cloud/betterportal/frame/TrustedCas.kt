package cloud.betterportal.frame

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore

internal fun readTrustJournal(journal: AtomicFile): JSONObject = try {
    JSONObject(journal.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
} catch (error: FileNotFoundException) {
    // openRead recovers Android 9's .bak before opening the base file.
    if (journal.baseFile.exists() || File(journal.baseFile.path + ".bak").exists()) throw error
    JSONObject()
}

/** Stores only public certificates. The lock also covers enrollment reset across Activity instances. */
internal class TrustedCas(context: Context) {
    private companion object { val lock = Any() }
    private val app = context.applicationContext
    private val journal = AtomicFile(File(app.noBackupFilesDir, "trusted-ca-ownership.json"))
    private val policy get() = app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val admin get() = ComponentName(app, KioskAdminReceiver::class.java)
    private fun read(): JSONObject = readTrustJournal(journal)
    private fun write(value: JSONObject) {
        val stream = journal.startWrite()
        try { stream.write(value.toString().toByteArray()); journal.finishWrite(stream) }
        catch (error: Exception) { journal.failWrite(stream); throw error }
    }
    fun sync(cas: JSONArray, active: () -> Boolean = { true }): JSONObject = synchronized(lock) {
        // Recheck after taking the lock: an old session must not reinstall CAs after reset.
        check(active()) { "Session stopped" }
        TrustedCaPolicy.sync(cas, ::read,
            { policy.isDeviceOwnerApp(app.packageName) || policy.isProfileOwnerApp(app.packageName) },
            {
                val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
                store.aliases().toList().mapNotNull { alias -> store.getCertificate(alias)?.encoded?.let(TrustedCaPolicy::fingerprint) }.toSet()
            },
            { cert -> check(policy.installCaCert(admin, cert.encoded) && policy.hasCaCertInstalled(admin, cert.encoded)) { "CA installation failed" } },
            { der -> policy.uninstallCaCert(admin, der); check(!policy.hasCaCertInstalled(admin, der)) { "CA removal failed" } },
            ::write)
    }
}
