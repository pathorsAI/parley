package com.pathors.parley.quickrecord

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import com.pathors.parley.MainActivity
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.ui.isSettled
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate

/**
 * "Start a meeting recording now", as a link — what the launcher shortcut and
 * the Quick Settings tile ([RecordTileService]) both open. iOS `QuickRecord`
 * (ParleyKit), which the lock-screen control, widget and Siri phrase open.
 *
 * ## Why the app is brought forward rather than recording in the background
 *
 * A meeting is something you look at — the timer, the waveform, the transcript
 * arriving — and a recording that started somewhere you cannot see is one you
 * cannot tell is working. Android would also refuse it: a `microphone`
 * foreground service cannot be started from the background. So every door ends
 * on the meeting screen, through the same `MeetingService.start` as the red
 * circle; the shortcut's whole job is to remove the taps in between.
 *
 * ## A request goes stale
 *
 * The link is honoured once, and only soon after it arrived. On a cold launch
 * it lands before the app knows whether anyone is signed in; if nobody is, the
 * onboarding wall comes up, and a request that waited through it would start
 * recording by itself minutes later, on a screen the user reached for a
 * different reason. [FRESHNESS_MS] is how long the tap is treated as still
 * being what the user wants — the same 30 seconds as iOS.
 */
object QuickRecord {
    const val URL = "parley://record"

    private const val SCHEME = "parley"
    private const val HOST = "record"

    /**
     * How long a request stays worth acting on. Long enough for a cold launch
     * and the account check; short enough that a request which waited on a
     * sign-in page is dropped rather than obeyed.
     */
    const val FRESHNESS_MS = 30_000L

    /**
     * Is this the start-a-recording link? Nothing else about it is read: there
     * are no parameters, and a meeting started this way is the same as one
     * started from the red circle.
     */
    fun isRequest(scheme: String?, host: String?): Boolean = scheme == SCHEME && host == HOST

    fun isRequest(uri: Uri): Boolean = isRequest(uri.scheme, uri.host)

    /** Should a request made at [requestedAtMs] still start a recording at [nowMs]? */
    fun isFresh(requestedAtMs: Long, nowMs: Long): Boolean {
        val age = nowMs - requestedAtMs
        return age in 0..FRESHNESS_MS
    }

    /**
     * Whether a fresh request should navigate to the meeting screen, given
     * where the app already is.
     *
     * Off the meeting screen, always: a new meeting screen adopts a meeting in
     * progress (a second tap is someone checking it is still going, not asking
     * for another) and starts one otherwise. On it, only when the meeting
     * there has an outcome — the new entry clears it and records again, as the
     * iOS Record tab does. A meeting screen with nothing settled on it is left
     * alone: it is recording, wrapping up, waiting on the microphone
     * permission, or has just asked the service to start and not heard back,
     * and replacing it could only ever be worse.
     */
    fun shouldOpenMeeting(onMeetingScreen: Boolean, meeting: MeetingState?): Boolean =
        !onMeetingScreen || (meeting != null && isSettled(meeting))

    /** The intent every door opens — explicit, so nothing else can answer it. */
    fun intent(context: Context): Intent =
        Intent(Intent.ACTION_VIEW, URL.toUri(), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/**
 * Holds a "start recording" request until the navigation graph is there to act
 * on it. iOS `QuickRecordInbox`.
 *
 * `parley://record` arrives in `MainActivity`, which on a cold launch is
 * before the stored token has been read and before the navigation graph
 * exists. So the link only leaves a note here, and the graph takes it when it
 * is composed or the moment the note changes. Taking it clears it: one tap is
 * one recording, never two — not after a rotation, not after the back stack is
 * restored, not when the same intent is replayed from Recents.
 *
 * Process-scoped on purpose. A request does not outlive the process that
 * received it; if the process dies before the graph takes it, it would have
 * been stale by the time anything came back anyway.
 */
class QuickRecordInbox {
    private val _requestedAt = MutableStateFlow<Long?>(null)

    /** When the pending request arrived, or null. Observed to react the moment one lands. */
    val requestedAt: StateFlow<Long?> = _requestedAt.asStateFlow()

    fun post(nowMs: Long = System.currentTimeMillis()) {
        _requestedAt.value = nowMs
    }

    /**
     * The pending request, if it is still worth acting on. Clears it either
     * way, so a stale note cannot come back later.
     */
    fun take(nowMs: Long = System.currentTimeMillis()): Boolean {
        val requestedAt = _requestedAt.getAndUpdate { null } ?: return false
        return QuickRecord.isFresh(requestedAt, nowMs)
    }

    companion object {
        /** The app's one inbox. */
        val shared = QuickRecordInbox()
    }
}
