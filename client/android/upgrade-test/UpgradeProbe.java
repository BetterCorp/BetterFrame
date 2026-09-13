package cloud.betterportal.frame.upgradetest;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Runs inside the installed release app's UID, without relying on obfuscated app classes. */
public final class UpgradeProbe extends Instrumentation {
    private static final String ALIAS = "betterframe-ci-upgrade-continuity";
    private static final byte[] PAYLOAD = "enrollment-and-cache-survive-update".getBytes(StandardCharsets.UTF_8);
    private Bundle arguments;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context context = getTargetContext();
            check((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0,
                "Upgrade must exercise a non-debuggable release APK");
            long version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode();
            check(version == Long.parseLong(arguments.getString("version")), "Unexpected installed version");
            String phase = arguments.getString("phase");
            File encrypted = new File(context.getNoBackupFilesDir(), "upgrade-probe.enc");
            File owner = new File(context.getFilesDir(), "upgrade-probe-uid.txt");
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if ("seed".equals(phase)) {
                check(!encrypted.exists() && !store.containsAlias(ALIAS), "Probe needs a clean initial install");
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, generator.generateKey());
                byte[] ciphertext = cipher.doFinal(PAYLOAD);
                byte[] record = new byte[cipher.getIV().length + ciphertext.length];
                System.arraycopy(cipher.getIV(), 0, record, 0, cipher.getIV().length);
                System.arraycopy(ciphertext, 0, record, cipher.getIV().length, ciphertext.length);
                Files.write(encrypted.toPath(), record);
                Files.write(owner.toPath(), Integer.toString(android.os.Process.myUid()).getBytes(StandardCharsets.UTF_8));
                check(context.getSharedPreferences("upgrade-probe", 0).edit().putString("marker", "paired").commit(),
                    "Could not persist preferences");
            } else {
                check("verify".equals(phase), "Unknown probe phase");
                check(store.containsAlias(ALIAS), "Android Keystore key was lost");
                check(Integer.toString(android.os.Process.myUid()).equals(
                    new String(Files.readAllBytes(owner.toPath()), StandardCharsets.UTF_8)), "Application UID changed");
                check("paired".equals(context.getSharedPreferences("upgrade-probe", 0).getString("marker", null)),
                    "Preferences were lost");
                byte[] record = Files.readAllBytes(encrypted.toPath());
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, (SecretKey) store.getKey(ALIAS, null),
                    new GCMParameterSpec(128, Arrays.copyOfRange(record, 0, 12)));
                check(Arrays.equals(PAYLOAD, cipher.doFinal(Arrays.copyOfRange(record, 12, record.length))),
                    "Encrypted private state changed");
            }
            result.putString("stream", "BF_UPGRADE_OK:" + phase + ":" + version);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "BF_UPGRADE_FAILED: " + error.toString());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
