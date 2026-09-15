package cloud.betterportal.frame

import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry

// Dialog transitions can leave cached accessibility nodes from the previous
// window. Poll the current tree while retaining all visibility/action assertions.
internal fun freshAccessibilityRoot(): AccessibilityNodeInfo? {
    val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    if (Build.VERSION.SDK_INT >= 34) automation.clearCache()
    return automation.rootInActiveWindow
}
