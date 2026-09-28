package com.pathors.parley.auth

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudUser
import kotlinx.coroutines.CancellationException

/**
 * Why a sign-in did not finish, as the sign-in screen tells it — never the raw
 * `?error=` code the hosted page handed back, which is a word for a developer.
 * The screen maps each case to copy; iOS `AppState.signInFailureMessage`.
 *
 * Only one case is ever *seen* on Android, and the same is true on iOS: "server
 * said N" and "the connection dropped" are what iOS says when `GET /me` fails
 * *after* a good hand-off, and at that point the token is already kept — the
 * session is real, and a flaky network must not throw it away — so the
 * signed-out screen that would have shown the sentence is already gone. Android
 * keeps the token in the same case, and so has nothing more to say.
 */
enum class SignInError {
    /**
     * "Sign-in didn't finish. Please try again." The callback carried an error
     * or no token, or the token it carried is not a session the cloud knows.
     */
    DIDNT_FINISH,
    ;

    companion object {
        /**
         * The `?error=` values that mean the person backed out — declining
         * Google's consent screen comes back as OAuth's `access_denied`. Backing
         * out says nothing, as on iOS (`canceledLogin`): they know.
         */
        private val CANCELLED = setOf("access_denied", "cancelled", "canceled", "user_cancelled", "user_canceled")

        /** The hosted page came back without a token: [reason] is its `?error=` or [AuthManager.NO_TOKEN]. */
        fun fromCallback(reason: String): SignInError? =
            if (reason.trim().lowercase() in CANCELLED) null else DIDNT_FINISH

        /**
         * `GET /me` right after a token was stored. A 401 or a 200 with no user
         * means the token is not a session — discard it and say so. Anything
         * else (offline, a 5xx) keeps it: the session is probably fine, and the
         * next call confirms it.
         */
        fun fromVerification(result: Result<CloudUser?>): SignInError? {
            val error = result.exceptionOrNull()
            if (error is CancellationException) throw error
            return when {
                result.isSuccess && result.getOrNull() == null -> DIDNT_FINISH
                (error as? CloudException)?.isAuthExpired == true -> DIDNT_FINISH
                else -> null
            }
        }
    }
}
