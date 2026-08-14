package com.pathors.parley.auth

import android.content.Context
import android.net.Uri
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.ParleyHttp
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The Preferences DataStore that holds the cloud session token. It lands in
 * `filesDir/datastore/parley_auth.preferences_pb`, which is app-private
 * (MODE_PRIVATE) and excluded from backup by `android:allowBackup="false"`.
 *
 * iOS keeps the same value in the Keychain; Android has no equivalent that
 * survives a reinstall, so the token simply lives with the app's own files.
 */
private val Context.parleyAuthStore: DataStore<Preferences> by preferencesDataStore(name = "parley_auth")

/** Outcome of feeding a `parley://` deep link to [AuthManager.handleAuthCallback]. */
sealed interface AuthCallback {
    /** The URI is not our sign-in callback — the caller should handle it elsewhere. */
    data object Ignored : AuthCallback

    /** The token was extracted and persisted; the app is now signed in. */
    data class Success(val token: String) : AuthCallback

    /**
     * The hosted page came back without a usable token. [reason] is the raw
     * `?error=` value from the backend (or [AuthManager.NO_TOKEN]) — a code, not
     * display copy; the UI layer maps it to a localized message.
     */
    data class Failure(val reason: String) : AuthCallback
}

/**
 * Owns the cloud session token: where it is stored, how the hosted sign-in page
 * is addressed, and how the `parley://auth-callback?token=…` hand-off turns into
 * a live session.
 *
 * The flow mirrors iOS `AppState.signIn()` exactly, with a Custom Tab standing in
 * for `ASWebAuthenticationSession`:
 *
 * 1. [signInUrl] → open it with [CustomTabsLauncher.launch].
 * 2. The user signs in on our origin (email+password, Google, Apple). Credentials
 *    never pass through the app.
 * 3. The page 302s to `parley://auth-callback?token=…`, which `MainActivity`
 *    receives (manifest intent filter) and feeds to [handleAuthCallback].
 * 4. Every later cloud call sends `Authorization: Bearer <token>`.
 */
class AuthManager(
    context: Context,
    private val baseUrl: String = CloudClient.DEFAULT_BASE_URL,
    private val http: OkHttpClient = ParleyHttp.shared,
) {
    private val store = context.applicationContext.parleyAuthStore

    /** The stored session token, or null when signed out. Emits on every change. */
    val tokenFlow: Flow<String?> =
        store.data.map { prefs -> prefs[TOKEN_KEY]?.takeIf { it.isNotEmpty() } }

    /**
     * Whether this device holds a session token at all. Deliberately *not* the
     * same question as "is the session valid" — iOS keeps a stored token when
     * `GET /me` fails on a flaky network, so being offline never looks like being
     * signed out. Confirm validity with `CloudClient.me()`, and only sign out on
     * a 401 (see [CloudClient]'s `onUnauthorized`).
     */
    val isSignedIn: Flow<Boolean> = tokenFlow.map { it != null }

    /** One-shot read of the current token. Cheap — DataStore caches in memory. */
    suspend fun currentToken(): String? = tokenFlow.first()

    /**
     * A [CloudClient] bound to this session: it reads the token per request, and
     * a 401 clears the stored session so the whole UI reflects signed-out from
     * one place. Build it once and share it — the underlying OkHttp client is
     * already shared, but one client instance keeps the 401 wiring in one spot.
     */
    fun cloudClient(): CloudClient = CloudClient(
        baseUrl = baseUrl,
        http = http,
        tokenProvider = ::currentToken,
        onUnauthorized = ::clearSession,
    )

    /**
     * The hosted sign-in page for this app.
     *
     * The query parameter is `to` (not `redirect_uri`): the backend's
     * `validReturnTarget` (cloud `src/signin.ts`) reads `?to=` and allows any
     * `parley://` target or an http loopback, falling back to
     * `parley://auth-callback` for anything else.
     *
     * Built with plain string encoding rather than `Uri.Builder` so it is exactly
     * what the desktop sends (`encodeURIComponent`) and so it can be unit-tested
     * off-device.
     */
    fun signInUrl(callback: String = DEFAULT_CALLBACK): String =
        "${baseUrl.trimEnd('/')}/sign-in?to=" +
            URLEncoder.encode(callback, StandardCharsets.UTF_8.name())

    /** Whether [uri] is the sign-in hand-off this manager knows how to complete. */
    fun isAuthCallback(uri: Uri): Boolean =
        uri.scheme == CALLBACK_SCHEME && (uri.host == CALLBACK_HOST || uri.host == IOS_CALLBACK_HOST)

    /**
     * Complete the hand-off: pull `?token=` out of the callback URI and persist it.
     * Mirrors iOS `CloudClient.token(fromCallback:)`, including the `?error=`
     * branch the hosted page uses when there was no session to hand back.
     */
    suspend fun handleAuthCallback(uri: Uri): AuthCallback {
        if (!isAuthCallback(uri)) return AuthCallback.Ignored
        uri.getQueryParameter("error")?.takeIf { it.isNotEmpty() }?.let {
            return AuthCallback.Failure(it)
        }
        val token = uri.getQueryParameter("token")?.takeIf { it.isNotEmpty() }
            ?: return AuthCallback.Failure(NO_TOKEN)
        saveToken(token)
        return AuthCallback.Success(token)
    }

    /** Persist a session token directly (the callback path, and debug adoption). */
    suspend fun saveToken(token: String) {
        val trimmed = token.trim()
        store.edit { prefs ->
            if (trimmed.isEmpty()) prefs.remove(TOKEN_KEY) else prefs[TOKEN_KEY] = trimmed
        }
    }

    /**
     * Forget the session locally. Called on a 401 (the token is dead, so there is
     * nothing to revoke) and as the first step of [signOut].
     */
    suspend fun clearSession() {
        store.edit { it.remove(TOKEN_KEY) }
    }

    /**
     * Sign out: clear locally first, then best-effort revoke the session on the
     * server — the desktop's order (`src/lib/cloud/client.ts`). A failed revoke
     * must never leave the app looking signed in.
     */
    suspend fun signOut() {
        val token = currentToken()
        clearSession()
        if (token == null) return
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${baseUrl.trimEnd('/')}/auth/sign-out")
                    .post("".toRequestBody(null))
                    .header("Authorization", "Bearer $token")
                    .build()
                http.newCall(request).execute().close()
            }
        }
    }

    companion object {
        /** Matches the `parley` / `auth-callback` intent filter in AndroidManifest.xml. */
        const val CALLBACK_SCHEME = "parley"
        const val CALLBACK_HOST = "auth-callback"

        /** iOS uses `parley://auth/cb`; accepted too so one token can serve both. */
        private const val IOS_CALLBACK_HOST = "auth"

        /** The return target handed to the hosted page. */
        const val DEFAULT_CALLBACK = "$CALLBACK_SCHEME://$CALLBACK_HOST"

        /** [AuthCallback.Failure] reason when the callback carried no token at all. */
        const val NO_TOKEN = "no_token_in_callback"

        private val TOKEN_KEY = stringPreferencesKey("cloud-session-token")
    }
}
