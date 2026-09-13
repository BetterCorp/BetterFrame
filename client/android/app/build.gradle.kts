plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val requireSigning = providers.environmentVariable("BF_ANDROID_REQUIRE_SIGNING").orNull?.let {
    require(it == "true" || it == "false") { "BF_ANDROID_REQUIRE_SIGNING must be true or false" }
    it == "true"
} ?: false
val signingInputs = listOf(
    "BF_ANDROID_KEYSTORE_PATH",
    "BF_ANDROID_KEYSTORE_PASSWORD",
    "BF_ANDROID_KEY_ALIAS",
    "BF_ANDROID_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it).orNull }
val keystoreType = providers.environmentVariable("BF_ANDROID_KEYSTORE_TYPE").orNull
val hasSigningInputs = signingInputs.values.any { it != null } || keystoreType != null
if (requireSigning || hasSigningInputs) {
    require(signingInputs.values.all { !it.isNullOrBlank() }) {
        "Release signing requires BF_ANDROID_KEYSTORE_PATH, BF_ANDROID_KEYSTORE_PASSWORD, " +
            "BF_ANDROID_KEY_ALIAS, and BF_ANDROID_KEY_PASSWORD"
    }
    require(keystoreType == null || keystoreType.isNotBlank()) {
        "BF_ANDROID_KEYSTORE_TYPE must not be blank"
    }
}
val releaseKeystore = signingInputs["BF_ANDROID_KEYSTORE_PATH"]?.let { file(it) }
if (hasSigningInputs) {
    require(releaseKeystore?.isFile == true && releaseKeystore.canRead()) {
        "BF_ANDROID_KEYSTORE_PATH must identify a readable keystore file"
    }
}

val configuredVersionCode = providers.environmentVariable("BF_ANDROID_VERSION_CODE").orNull
val configuredVersionName = providers.environmentVariable("BF_ANDROID_VERSION_NAME").orNull
if (requireSigning) {
    require(configuredVersionCode != null && configuredVersionName != null) {
        "Signed production builds require explicit BF_ANDROID_VERSION_CODE and BF_ANDROID_VERSION_NAME"
    }
}
val releaseVersionCode = configuredVersionCode?.let {
    val parsed = it.toIntOrNull()
    require(it.matches(Regex("[0-9]+")) && parsed != null && parsed in 1..2_100_000_000) {
        "BF_ANDROID_VERSION_CODE must be an integer between 1 and 2100000000"
    }
    parsed
} ?: 1
val releaseVersionName = configuredVersionName?.also {
    require(it.isNotBlank()) { "BF_ANDROID_VERSION_NAME must not be blank" }
} ?: "0.1.0"

android {
    namespace = "cloud.betterportal.frame"
    compileSdk = 35
    ndkVersion = "27.2.12479018"
    defaultConfig {
        applicationId = "cloud.betterportal.frame"
        minSdk = 28
        targetSdk = 35
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    signingConfigs {
        if (hasSigningInputs) {
            create("release") {
                storeFile = releaseKeystore
                storeType = keystoreType ?: "PKCS12"
                storePassword = signingInputs.getValue("BF_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingInputs.getValue("BF_ANDROID_KEY_ALIAS")
                keyPassword = signingInputs.getValue("BF_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (hasSigningInputs) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("rustJniLibs"))
}

val buildRust by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("bash", "scripts/build-rust.sh", layout.buildDirectory.dir("rustJniLibs").get().asFile.absolutePath)
    environment("ANDROID_NDK_HOME", android.sdkDirectory.resolve("ndk/${android.ndkVersion}").absolutePath)
    inputs.dir(rootProject.file("../core/src"))
    inputs.dir(rootProject.file("../android-bridge/src"))
    inputs.file(rootProject.file("../android-bridge/Cargo.toml"))
    inputs.file(rootProject.file("../core/Cargo.toml"))
    inputs.file(rootProject.file("../Cargo.lock"))
    inputs.file(rootProject.file("scripts/build-rust.sh"))
    outputs.dir(layout.buildDirectory.dir("rustJniLibs"))
}
tasks.named("preBuild") { dependsOn(buildRust) }

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-rtsp:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
