import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ── Upload-key signing ──────────────────────────────────────────────────────
// Play App Signing holds the real app signing key; what we sign with here is the
// *upload* key (see RELEASING.md). Its location and passwords come from, in order
// of precedence, environment variables (how CI passes them) then local.properties
// (how a maintainer keeps them off the command line). Nothing is ever committed.
//
// Parley is open source, so the common case is a contributor with no keystore at
// all. That must not break the build: when the settings are absent we simply do
// not create the signing config, and `assembleRelease`/`bundleRelease` produce an
// unsigned artifact — a warning, never a configuration-time failure.

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingSetting(envName: String, propertyName: String): String? =
    (System.getenv(envName) ?: localProperties.getProperty(propertyName))
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

val uploadKeystorePath = signingSetting("PARLEY_UPLOAD_KEYSTORE", "parley.upload.keystore")
val uploadKeystorePassword =
    signingSetting("PARLEY_UPLOAD_KEYSTORE_PASSWORD", "parley.upload.keystore.password")
val uploadKeyAlias = signingSetting("PARLEY_UPLOAD_KEY_ALIAS", "parley.upload.key.alias")
val uploadKeyPassword =
    signingSetting("PARLEY_UPLOAD_KEY_PASSWORD", "parley.upload.key.password")

// Relative paths resolve against `android/`; absolute paths (what CI writes into
// $RUNNER_TEMP) pass through untouched.
val uploadKeystoreFile = uploadKeystorePath?.let { rootProject.file(it) }

val uploadSigningReady = uploadKeystoreFile != null &&
    uploadKeystoreFile.isFile &&
    uploadKeystorePassword != null &&
    uploadKeyAlias != null &&
    uploadKeyPassword != null

if (!uploadSigningReady) {
    // Only complain when a release artifact is actually being produced — a
    // contributor running `assembleDebug` has no reason to hear about this.
    val reason = when {
        uploadKeystorePath == null ->
            "PARLEY_UPLOAD_KEYSTORE is not set (env or local.properties `parley.upload.keystore`)"
        uploadKeystoreFile?.isFile != true ->
            "keystore file not found at ${uploadKeystoreFile?.absolutePath}"
        else ->
            "missing " + listOfNotNull(
                "PARLEY_UPLOAD_KEYSTORE_PASSWORD".takeIf { uploadKeystorePassword == null },
                "PARLEY_UPLOAD_KEY_ALIAS".takeIf { uploadKeyAlias == null },
                "PARLEY_UPLOAD_KEY_PASSWORD".takeIf { uploadKeyPassword == null },
            ).joinToString(", ")
    }
    gradle.taskGraph.whenReady {
        val buildingRelease = allTasks.any {
            it.project.path == ":app" && it.name.endsWith("Release")
        }
        if (buildingRelease) {
            logger.warn(
                "\n[parley] Release artifacts will be UNSIGNED: $reason." +
                    "\n[parley] This is expected for contributors without the upload key; the" +
                    "\n[parley] output cannot be installed on a device or uploaded to Play." +
                    "\n[parley] See android/RELEASING.md → \"Signing setup\".\n",
            )
        }
    }
}

android {
    namespace = "com.pathors.parley"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pathors.parley"
        // minSdk 29: the MediaCodec Opus *encoder* arrived in API 29. The Ogg
        // container is written by hand now (see audio/OggStreamWriter.kt), so
        // MediaMuxer's OGG output — which also needed 29 — no longer figures.
        minSdk = 29
        targetSdk = 36
        versionCode = 6

        // 1.13, not 0.2: the jump is the point. Android shipped as 0.1.x while it
        // carried iOS 1.1's feature set, and this release is the one that closes
        // that gap — playback, search, onboarding, re-transcription, and a
        // recording that survives the things that used to delete it. Matching the
        // iOS number also means the two stores stop describing the same product
        // with numbers ten releases apart. There is no Android 1.0–1.12; the gap
        // in the tag history is the honest record of how this went.
        versionName = "1.13"

        // Instrumented tests only: audio/OggOpusEncoderDeviceTest drives the real
        // MediaCodec Opus encoder, which has no JVM stand-in.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (uploadSigningReady) {
            create("release") {
                storeFile = uploadKeystoreFile
                storePassword = uploadKeystorePassword
                keyAlias = uploadKeyAlias
                keyPassword = uploadKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Null when no upload key is configured → AGP emits an unsigned
            // app-release-unsigned.apk / unsigned .aab instead of failing.
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        // BuildConfig.DEBUG gates the store-screenshot demo mode, so a release
        // build cannot be talked into serving fixtures by a deep link.
        buildConfig = true
    }
}

dependencies {
    implementation(project(":parleykit"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)
    // Media3/ExoPlayer plays the recording back. Its OggExtractor seeks
    // Opus streams natively, which is why Android needs none of the
    // hand-written seek machinery iOS had to build (see PlaybackEngine.kt).
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.browser)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
