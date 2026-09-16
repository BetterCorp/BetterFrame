package cloud.betterportal.frame

import android.os.Build
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.platform.app.InstrumentationRegistry

// The accessibility-active window can follow the last touch or the IME rather
// than the input-focused dialog. Inspect that dialog explicitly, never an
// underlying activity whose missing text could falsely prove dismissal.
internal fun freshAccessibilityRoot(): AccessibilityNodeInfo? {
    val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    val service = automation.serviceInfo
    if (service.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0) {
        service.flags = service.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        automation.serviceInfo = service
    }
    if (Build.VERSION.SDK_INT >= 34) automation.clearCache()
    val focused = automation.windows.firstOrNull { it.isFocused } ?: return null
    if (focused.type != AccessibilityWindowInfo.TYPE_APPLICATION) return null
    val root = focused.root ?: return null
    return root.takeIf {
        it.packageName?.toString() == InstrumentationRegistry.getInstrumentation().targetContext.packageName
    }
}
