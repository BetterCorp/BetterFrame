package cloud.betterportal.frame

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Run only through scripts/test-managed-kiosk.sh on its disposable CI emulator. */
@RunWith(AndroidJUnit4::class)
class ManagedKioskDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val policy get() = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    @Test fun ownerPolicySleepsAndRestoresTheKiosk() {
        requireDisposableEmulator()
        assertTrue("CI must provision the owner before this test", policy.isDeviceOwnerApp(context.packageName))
        var activity: MainActivity? = null
        try {
            val viewer = launchOffline()
            activity = viewer
            val managed = ManagedKiosk(viewer)
            instrumentation.runOnMainSync {
                assertTrue(managed.isOwner)
                managed.enable()
                assertTrue(managed.isAllowed)
            }
            val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            await("Dedicated lock task starts") { manager.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_LOCKED }
            val home = context.packageManager.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)
            assertEquals("BetterFrame becomes the persistent Home", "${context.packageName}.KioskHome", home?.activityInfo?.name)
            val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            instrumentation.runOnMainSync { managed.screenOff() }
            await("Owner power command turns the screen off") { !power.isInteractive }
            wakeEmulator()
            await("Power wake restores the kiosk") {
                var focused = false
                instrumentation.runOnMainSync { focused = viewer.hasWindowFocus() }
                power.isInteractive && focused && manager.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_LOCKED
            }
            instrumentation.runOnMainSync { managed.disable() }
            await("Disabling policy exits lock task") { manager.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE }
            assertFalse(managed.isAllowed)
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, context.packageManager.getComponentEnabledSetting(
                ComponentName(context.packageName, "${context.packageName}.KioskHome")))
        } finally {
            cleanup(activity)
        }
    }

    /** Separate invocation from the shell EXIT trap also recovers a crashed test process. */
    @Test fun clearOwnerAfterInterruptedRun() {
        requireDisposableEmulator()
        cleanup(null)
    }

    private fun launchOffline(): MainActivity {
        ProtectedStore(context).write(JSONObject().put("server", "http://127.0.0.1:9"))
        return instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
    }

    @Suppress("DEPRECATION") // Only removes our temporary CI owner, never called by production code.
    private fun cleanup(existing: MainActivity?) {
        wakeEmulator()
        var activity = existing
        try {
            if (policy.isDeviceOwnerApp(context.packageName)) {
                try {
                    if (activity == null || activity.isDestroyed) activity = launchOffline()
                    val viewer = activity!!
                    instrumentation.runOnMainSync { ManagedKiosk(viewer).disable() }
                } finally {
                    policy.clearDeviceOwnerApp(context.packageName)
                }
            }
            assertFalse("Release owner before the signed-upgrade suite uninstalls BF", policy.isDeviceOwnerApp(context.packageName))
        } finally {
            activity?.let { viewer -> instrumentation.runOnMainSync { viewer.finish() } }
            instrumentation.waitForIdleSync()
            ProtectedStore(context).clear()
        }
    }

    private fun requireDisposableEmulator() {
        check(InstrumentationRegistry.getArguments().getString("bfManagedCi") == "true") { "Explicit managed CI opt-in required" }
        check(shell("getprop ro.kernel.qemu").trim() == "1") { "Managed provisioning tests require an emulator" }
    }

    private fun wakeEmulator() {
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
    }

    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }

    private fun await(message: String, predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.uptimeMillis() + 10_000
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(50)
        }
        fail(message)
    }
}
