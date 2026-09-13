package net.bettercorp.betterframe.viewer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** One atomic encrypted record keeps identity, pending enrollment and cache consistent. */
class ProtectedStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "viewer-state.enc"))
    private val alias = "betterframe-viewer-state-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(): JSONObject {
        if (!file.baseFile.exists()) return JSONObject()
        val bytes = file.readFully()
        require(bytes.size > 29 && bytes[0] == 1.toByte()) { "Unreadable saved enrollment; reset locally to pair again" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
    }
    @Synchronized fun write(state: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(state.toString().toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
    }
    @Synchronized fun clear() { file.delete() }
}
