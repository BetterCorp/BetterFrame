plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.bettercorp.betterframe.viewer"
    compileSdk = 35
    ndkVersion = "27.2.12479018"
    defaultConfig {
        applicationId = "net.bettercorp.betterframe.viewer"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        release {
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
