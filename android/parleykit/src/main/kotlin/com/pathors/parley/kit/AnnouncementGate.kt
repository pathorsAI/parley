package com.pathors.parley.kit

import kotlinx.serialization.Serializable

/**
 * What the phone remembers about announcements: which ones it is done with.
 *
 * "Seen" means *never show this one here*, whether the user actually read it
 * (dismissed the sheet), it was superseded by a newer one that was shown
 * instead, or the phone was a fresh install when it arrived. The three are not
 * told apart because nothing downstream would treat them differently.
 */
@Serializable
data class AnnouncementState(val seen: Set<String> = emptySet())

/**
 * Whether the phone shows an announcement, and which — as pure rules over
 * values, iOS `AnnouncementGate` with Android's version and Android's
 * audiences. The app's `AnnouncementStore` persists the state and
 * `WhatsNewPresenter` decides *when* it may ask; this decides *what* the answer
 * is.
 *
 * ## The rules
 *
 * 1. **A fresh install never sees one.** "What's new" is a sentence addressed
 *    to someone who knew what was there before. The first launch of a build
 *    with no stored state asks whether a session token is already stored
 *    ([initial]): if it is, the user signed in under an earlier build and is
 *    upgrading; if not, every bundled announcement is marked seen on the spot.
 * 2. **Only what this version actually ships.** `ships.android` must be set and
 *    at most the running `versionName` ([AppVersion], numeric by component).
 *    An entry committed ahead of its release sits in the bundle doing nothing,
 *    and one with `android: null` is another platform's news.
 * 3. **Only for its audience.** [AnnouncementAudience.Keyboard] needs the
 *    Parley keyboard to have been used on this phone (`keyboardUsed`, which
 *    the app sets the first time its input method is shown); an audience this
 *    build does not know is unmet.
 * 4. **One sheet, the newest.** Several unseen at once — someone skipped a few
 *    releases — shows only the newest (highest `ships.android`, then the later
 *    id), and the older ones are retired alongside it.
 *
 * An announcement whose audience is unmet is left alone rather than retired,
 * as on iOS: if the user picks up the keyboard later, the sheet about the
 * keyboard is still waiting — unless something newer has been shown in the
 * meantime, which retires it with the rest.
 */
object AnnouncementGate {

    /** What the store should do right now. */
    data class Decision(
        /** The one to present, if any. */
        val show: Announcement? = null,
        /**
         * What to mark seen *when [show] is dismissed*: [show] itself and every
         * older released announcement it supersedes. Empty when nothing shows.
         */
        val retire: Set<String> = emptySet(),
    ) {
        companion object {
            val NOTHING = Decision()
        }
    }

    /**
     * The state the phone starts with the first time a build that has
     * announcements runs. [hadStoredSession] is whether a session token was
     * already stored before anything in this launch could have written one —
     * an existing user updating. Anyone else is a new install and starts with
     * every bundled announcement behind them, including ones for versions later
     * than this build.
     */
    fun initial(bundled: List<Announcement>, hadStoredSession: Boolean): AnnouncementState =
        if (hadStoredSession) AnnouncementState() else AnnouncementState(bundled.map { it.id }.toSet())

    /**
     * The decision for this launch.
     *
     * @param announcements what the bundle carries.
     * @param state what the phone has already seen.
     * @param appVersion the running build's `versionName`. One that cannot be
     *   read shows nothing.
     * @param keyboardUsed whether the Parley keyboard has been used on this
     *   phone. False until it has, so keyboard announcements wait.
     */
    fun decide(
        announcements: List<Announcement>,
        state: AnnouncementState,
        appVersion: String,
        keyboardUsed: Boolean = false,
    ): Decision {
        val running = AppVersion.parse(appVersion) ?: return Decision.NOTHING

        // Released on Android, in this version or earlier, and not yet behind us.
        val released = announcements.mapNotNull { item ->
            if (item.id in state.seen) return@mapNotNull null
            val ships = item.ships.android?.let(AppVersion::parse) ?: return@mapNotNull null
            if (ships > running) null else item to ships
        }

        val newest = released
            .filter { (item, _) -> audienceMet(item.audience ?: AnnouncementAudience.All, keyboardUsed) }
            .maxWithOrNull(compareBy<Pair<Announcement, AppVersion>> { it.second }.thenBy { it.first.id })
            ?: return Decision.NOTHING

        // Everything released that the newest one outranks, audience or not.
        val retired = released.filter { (item, ships) ->
            ships < newest.second || (ships == newest.second && item.id < newest.first.id)
        }
        return Decision(
            show = newest.first,
            retire = retired.map { it.first.id }.toSet() + newest.first.id,
        )
    }

    /** iOS `audienceMet(_:keyboardUsed:)`. */
    fun audienceMet(audience: AnnouncementAudience, keyboardUsed: Boolean): Boolean = when (audience) {
        AnnouncementAudience.All -> true
        AnnouncementAudience.Keyboard -> keyboardUsed
        is AnnouncementAudience.Unknown -> false
    }
}
