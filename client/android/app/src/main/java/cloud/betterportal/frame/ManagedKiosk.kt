package cloud.betterportal.frame

import android.app.Activity
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager

/** Optional device-owner entry point. An ordinary APK install grants no admin privileges. */
class KioskAdminReceiver : DeviceAdminReceiver()

internal class ManagedKiosk(private val activity: Activity) {
    private val policy get() = activity.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val admin get() = ComponentName(activity, KioskAdminReceiver::class.java)
    private val home get() = ComponentName(activity.packageName, "${activity.packageName}.KioskHome")
    val isOwner get() = policy.isDeviceOwnerApp(activity.packageName)
    val isAllowed get() = policy.isLockTaskPermitted(activity.packageName)

    fun resume() {
        // Never invoke ordinary screen pinning or claim management privileges from an APK install.
        val manager = activity.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        if (isAllowed && manager.lockTaskModeState == android.app.ActivityManager.LOCK_TASK_MODE_NONE) activity.startLockTask()
    }

    fun enable() {
        check(isOwner) { "Provision BetterFrame as device owner first." }
        activity.packageManager.setComponentEnabledSetting(home, PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            PackageManager.DONT_KILL_APP)
        policy.setLockTaskPackages(admin, (policy.getLockTaskPackages(admin).toList() + activity.packageName).distinct().toTypedArray())
        policy.addPersistentPreferredActivity(admin, IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }, home)
        resume()
    }

    fun disable() {
        check(isOwner) { "Kiosk policy is controlled by your device manager." }
        activity.stopLockTask()
        policy.clearPackagePersistentPreferredActivities(admin, activity.packageName)
        policy.setLockTaskPackages(admin, policy.getLockTaskPackages(admin).filter { it != activity.packageName }.toTypedArray())
        activity.packageManager.setComponentEnabledSetting(home, PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP)
    }

    fun screenOff() {
        check(isOwner) { "Screen-off requires BetterFrame device-owner provisioning." }
        // Actual hardware sleep intentionally uses normal power-button wake/unlock.
        // Remote BF wake remains available through soft standby instead.
        policy.lockNow()
    }
}
