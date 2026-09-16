package cloud.betterportal.frame

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class CameraDecoderPolicyTest {
    private data class Decoder(val name: String, val hardware: Boolean)

    @Test fun hardwareExhaustionStillLeavesSoftwareCandidatesInPlatformPreferenceOrder() {
        val softwareA = Decoder("software-a", false)
        val hardwareA = Decoder("hardware-a", true)
        val softwareB = Decoder("software-b", false)
        val hardwareB = Decoder("hardware-b", true)
        val candidates = CameraDecoderPolicy.candidates(
            "video/avc", listOf(softwareA, hardwareA, softwareB, hardwareB), Decoder::hardware,
        )
        assertEquals(listOf(hardwareA, hardwareB, softwareA, softwareB), candidates)
        // After all hardware allocations fail, Media3 must still have both fallbacks.
        assertEquals(listOf(softwareA, softwareB), candidates.dropWhile { it.hardware })
    }

    @Test fun softwareOnlyDeviceRemainsPlayable() {
        val software = listOf(Decoder("software-avc", false))
        assertEquals(software, CameraDecoderPolicy.candidates("video/avc", software, Decoder::hardware))
        assertEquals(emptyList<Decoder>(), CameraDecoderPolicy.candidates("video/avc", emptyList(), Decoder::hardware))
    }

    @Test fun audioKeepsItsPlatformPreferenceOrder() {
        val audio = listOf(Decoder("software-aac", false), Decoder("hardware-aac", true))
        assertSame(audio, CameraDecoderPolicy.candidates("audio/mp4a-latm", audio, Decoder::hardware))
    }
}
