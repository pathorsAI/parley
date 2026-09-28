package com.pathors.parley.kit

import okhttp3.Interceptor

/**
 * `X-Parley-Client: <platform>/<versionName> (<build>)` — which app, and which
 * build of it, sent a request.
 *
 * ## Why every request carries it
 *
 * Android 1.13 left almost every new user without a transcript for ten days and
 * nobody said a word. The signal was in the database the whole time — short
 * empty recordings, rapid restarts — but nothing on a row said *which build*
 * produced it, so "Android is broken" could not be told apart from "one old
 * build is broken" without asking every user. With this header the cloud stamps
 * `client_platform` / `client_version` on every recording and every STT session
 * row, and the admin's reliability view can split each signal by version.
 *
 * ## Why it is one interceptor and not a parameter
 *
 * A header that each call site has to remember is a header some call site will
 * forget, and the one it forgets is the one that matters (the STT WebSocket is
 * built in a different module from the REST client, by two different sessions).
 * So the value is installed once, at process start, and both OkHttp clients the
 * app owns — the REST client in `app` and the relay client here — carry
 * [interceptor]. OkHttp runs application interceptors for the WebSocket upgrade
 * request too, which is what lets the relay handshake carry a real header rather
 * than the `?client=` query fallback the spec allows for sockets that cannot.
 *
 * The value is process-wide rather than per client because it *is* a property
 * of the process: one APK, one version. `parleykit` is pure JVM and cannot read
 * `BuildConfig`, so the app hands it over from `Application.onCreate` — before
 * anything can open a connection.
 */
object ParleyClientHeader {

    /** The header name, exactly as the cloud reads it. */
    const val NAME = "X-Parley-Client"

    /** The platforms the cloud's parser accepts. Only [ANDROID] is ever sent from here. */
    const val ANDROID = "android"

    /** The longest version the cloud will accept (`[^\s()]{1,32}`). */
    private const val MAX_VERSION_LENGTH = 32

    /** The longest build number the cloud will accept (`\d{1,10}`). */
    private const val MAX_BUILD_DIGITS = 10

    /**
     * The installed value, or null before [install] — in which case nothing is
     * added. A unit test that never installs one sees the requests it always saw.
     */
    @Volatile
    var value: String? = null
        private set

    /**
     * Set the header for the rest of the process. Called once, from
     * `Application.onCreate`; calling it again replaces the value (tests do).
     */
    fun install(platform: String, versionName: String, build: String) {
        value = format(platform, versionName, build)
    }

    /** Forget the installed value. Tests only. */
    fun reset() {
        value = null
    }

    /**
     * `android/1.16 (9)`.
     *
     * Shaped so it always parses: the cloud's pattern is
     * `^(ios|android|macos|windows|linux)/([^\s()]{1,32})(?:\s\((\d{1,10})\))?$`
     * and anything that fails it is stored as "unknown" — not rejected, but lost.
     * So whitespace and parentheses are taken out of the version (a
     * `versionNameSuffix` like `1.16 (beta)` would otherwise sink the whole
     * value), it is cut to 32 characters, and a build that is not all digits is
     * dropped rather than sent broken.
     */
    fun format(platform: String, versionName: String, build: String): String {
        val version = versionName
            .filterNot { it.isWhitespace() || it == '(' || it == ')' }
            .take(MAX_VERSION_LENGTH)
            .ifEmpty { "0" }
        val digits = build.trim()
        val hasBuild = digits.isNotEmpty() &&
            digits.length <= MAX_BUILD_DIGITS &&
            digits.all { it in '0'..'9' }
        return if (hasBuild) "$platform/$version ($digits)" else "$platform/$version"
    }

    /**
     * Adds [NAME] to every request that does not already carry one. A request
     * that sets its own (a test, or a future caller that means to) wins.
     */
    val interceptor: Interceptor = Interceptor { chain ->
        val request = chain.request()
        val header = value
        if (header == null || request.header(NAME) != null) {
            chain.proceed(request)
        } else {
            chain.proceed(request.newBuilder().header(NAME, header).build())
        }
    }
}
