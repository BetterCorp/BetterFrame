package cloud.betterportal.frame

/** Preserve the platform fallback candidates instead of imposing its hardware instance ceiling. */
internal object CameraDecoderPolicy {
    fun <T> candidates(mimeType: String, decoders: List<T>, hardwareAccelerated: (T) -> Boolean): List<T> =
        if (mimeType.startsWith("video/")) decoders.sortedBy { !hardwareAccelerated(it) } else decoders
}
