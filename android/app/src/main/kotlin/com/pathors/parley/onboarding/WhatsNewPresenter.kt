package com.pathors.parley.onboarding

import com.pathors.parley.kit.Announcement
import com.pathors.parley.kit.AnnouncementGate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * *When* the What's New sheet may come up — iOS `WhatsNewPresenter`. The store
 * and the gate decide *whether* and *which*.
 *
 * The sheet is the app talking about itself, so it waits for a moment when
 * nobody is in the middle of anything. It is presented only when all of these
 * hold, checked at the moment of presenting rather than when the attempt was
 * scheduled:
 *
 * - **The signed-in library is on screen** ([homeAppeared]). The host lives in
 *   the navigation graph's home destination, which is only ever drawn behind the
 *   sign-in wall.
 * - **The app is in the foreground** ([isForeground]).
 * - **No meeting is holding the microphone** ([meetingHoldsMic]) — a meeting
 *   reached from its ongoing notification lands on the meeting screen anyway,
 *   but a sheet must never cover a live recording.
 * - **This foreground was not opened by a `parley://` link**
 *   ([noteOpenedByDeepLink], from `MainActivity.handleDeepLink`): whoever sent
 *   one — the sign-in hand-off, a screenshot run — was in the middle of
 *   something. Such a foreground is skipped entirely, and the sheet waits for
 *   the next one that starts without a link.
 * - **Not already shown in this foreground**, and **not in screenshot demo
 *   mode** ([suppressed]): a sheet over the store frames would ruin every one.
 *
 * The attempt runs [SETTLE_DELAY_MS] after the library appears or the app
 * comes to the foreground, so it lands after the launch transition rather than
 * on top of it — and so a link delivered a beat after the foreground began has
 * time to arrive and veto it.
 *
 * A sheet taken down by the app rather than the user ([retract]: a link
 * arrived, the library went away under it) is *not* marked seen — the user
 * never got to read it, and it comes back at the next opportunity.
 */
class WhatsNewPresenter(
    /** Main-thread scope: [presented] drives Compose. */
    private val scope: CoroutineScope,
    private val decide: suspend () -> AnnouncementGate.Decision,
    private val markSeen: suspend (Set<String>) -> Unit,
    private val isForeground: () -> Boolean,
    private val meetingHoldsMic: () -> Boolean,
    private val suppressed: () -> Boolean = { false },
) {

    private val _presented = MutableStateFlow<Announcement?>(null)

    /** The announcement the sheet should be showing, or null. */
    val presented: StateFlow<Announcement?> = _presented.asStateFlow()

    /** What to mark seen when the presented sheet is dismissed. */
    private var retiring: Set<String> = emptySet()

    private var homeVisible = false
    private var openedByDeepLink = false
    private var shownThisForeground = false
    private var attempt: Job? = null

    // events

    fun homeAppeared() {
        homeVisible = true
        schedule()
    }

    fun homeDisappeared() {
        homeVisible = false
        attempt?.cancel()
        retract()
    }

    /** The process came to the foreground (`ProcessLifecycleOwner` ON_START). */
    fun foregrounded() {
        schedule()
    }

    /**
     * The process went to the background (`ProcessLifecycleOwner` ON_STOP): the
     * foreground is over, and the next one starts with a clean slate.
     */
    fun backgrounded() {
        openedByDeepLink = false
        shownThisForeground = false
        attempt?.cancel()
    }

    /** Called from `MainActivity.handleDeepLink` for every `parley://` link. */
    fun noteOpenedByDeepLink() {
        openedByDeepLink = true
        attempt?.cancel()
        retract()
    }

    /**
     * The user closed the sheet — its button, a swipe, the scrim, the system
     * back. Everything it retires is marked seen. Safe to call twice.
     */
    fun dismissed() {
        if (_presented.value == null) return
        val ids = retiring
        retiring = emptySet()
        _presented.value = null
        scope.launch { markSeen(ids) }
    }

    // presenting

    private fun schedule() {
        attempt?.cancel()
        attempt = scope.launch {
            delay(SETTLE_DELAY_MS)
            presentIfAppropriate()
        }
    }

    private suspend fun presentIfAppropriate() {
        if (!appropriate()) return
        val decision = decide()
        val show = decision.show ?: return
        // Asked again: deciding reads the disk, and the world may have moved on.
        if (!appropriate()) return
        retiring = decision.retire
        shownThisForeground = true
        _presented.value = show
    }

    private fun appropriate(): Boolean =
        homeVisible &&
            !openedByDeepLink &&
            !shownThisForeground &&
            _presented.value == null &&
            isForeground() &&
            !meetingHoldsMic() &&
            !suppressed()

    private fun retract() {
        if (_presented.value == null) return
        retiring = emptySet()
        _presented.value = null
    }

    companion object {
        /** How long after the library appears (or the app comes forward) before the sheet may present. */
        const val SETTLE_DELAY_MS = 600L
    }
}
