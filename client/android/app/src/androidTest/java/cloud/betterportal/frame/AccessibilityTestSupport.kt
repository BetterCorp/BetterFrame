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

// Capture the failing window before a fixture's finally block destroys it.
internal fun captureUiFailure(message: String) {
    runCatching {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val stem = "failure-${android.os.SystemClock.uptimeMillis()}"
        val directory = requireNotNull(context.getExternalFilesDir(null))
        val report = java.io.File(directory, "$stem.txt")
        val details = StringBuilder(message).append('\n')
        instrumentation.runOnMainSync {
            val monitor = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            val activities = listOf(androidx.test.runner.lifecycle.Stage.RESUMED,
                androidx.test.runner.lifecycle.Stage.STARTED).flatMap { monitor.getActivitiesInStage(it) }.distinct()
            for (activity in activities.filterIsInstance<MainActivity>()) {
                details.append("Activity focus=${activity.hasWindowFocus()} finishing=${activity.isFinishing}\n")
                for (name in listOf("active", "started", "displayVisible", "resetRequested", "plan")) {
                    val value = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
                    val summary = if (value is org.json.JSONObject)
                        "layout=${value.optString("layoutId")} expanded=${value.optString("expandedCellId")} cells=${value.optJSONArray("cells")?.length()}"
                        else value
                    details.append("$name=$summary\n")
                }
                val dialogs = MainActivity::class.java.getDeclaredField("dialogs").apply { isAccessible = true }
                    .get(activity) as Set<*>
                for (dialog in dialogs.filterIsInstance<android.app.AlertDialog>()) {
                    details.append("Dialog showing=${dialog.isShowing} focus=${dialog.window?.decorView?.hasWindowFocus()}\n")
                    val list = dialog.listView
                    if (list != null) details.append("Rows=${(0 until list.count).map { list.adapter.getItem(it) }}\n")
                }
            }
        }
        fun describe(node: AccessibilityNodeInfo, depth: Int = 0) {
            if (depth > 12) return
            val bounds = android.graphics.Rect().also(node::getBoundsInScreen)
            details.append("${" ".repeat(depth)}${node.className} text=${node.text} visible=${node.isVisibleToUser} bounds=$bounds\n")
            for (index in 0 until node.childCount) node.getChild(index)?.let { describe(it, depth + 1) }
        }
        for (window in instrumentation.uiAutomation.windows) {
            details.append("Window id=${window.id} type=${window.type} focus=${window.isFocused} active=${window.isActive}\n")
            window.root?.let { details.append("package=${it.packageName}\n"); describe(it) }
        }
        report.writeText(details.toString())
        val screenshot = java.io.File(directory, "$stem.png")
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            try { screenshot.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
            finally { bitmap.recycle() }
        }
        val shared = "/sdcard/Download/betterframe-kiosk-screenshots"
        for (command in listOf("mkdir -p $shared", "cp ${report.absolutePath} $shared/${report.name}",
            "cp ${screenshot.absolutePath} $shared/${screenshot.name}")) {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
                .use { it.readBytes() }
        }
    }.onFailure { android.util.Log.e("BetterFrameTest", "Failed to capture UI diagnostics", it) }
}
