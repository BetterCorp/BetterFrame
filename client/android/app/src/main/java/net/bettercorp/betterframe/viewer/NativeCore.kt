package net.bettercorp.betterframe.viewer

/** The canonical BF bundle and layout policy live in client/core. No video crosses JNI. */
object NativeCore {
    init { System.loadLibrary("betterframe_android_bridge") }
    external fun renderPlan(bundleJson: String, layoutId: String?, expandedCellId: String?): String
    external fun resolveWebUrl(value: String, serverUrl: String): String?
    external fun cameraUri(uri: String, username: String?, encryptedPassword: String?, encryptKey: String?): String?
    external fun websocketUrl(serverUrl: String, token: String): String?
}
