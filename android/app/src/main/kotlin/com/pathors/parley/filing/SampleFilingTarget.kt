package com.pathors.parley.filing

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FilingSuggestion

/**
 * Where the bundled sample's filing answer is written — iOS
 * `FilingSuggestionModel.Target.sample`.
 *
 * The sample is local-only: it never reaches the cloud, so an accepted
 * suggestion renames and files its entry on this phone. A folder the user
 * chooses to create for it is still created in the cloud — it is a real
 * folder the user now has — and only the filing itself stays local.
 *
 * The sample ships with a suggestion already pending (the manifest's own
 * title and folder), so the recording page offers it the first time the
 * sample is opened and never again once it has been answered.
 *
 * `SampleRecordingStore` implements it: its `suggestionPending` flag and the
 * manifest's `filingSuggestion()` are the data behind it.
 */
interface SampleFilingTarget {

    /**
     * The sample's suggestion while it is still waiting on an answer, or null
     * once it has been answered (accepted in full, or skipped) — or when the
     * sample has none. [folders] is the user's personal folder list: up to two
     * recently used ones join the manifest's customer folder, and a live folder
     * with the customer's name is pointed at rather than created again.
     */
    suspend fun pendingFilingSuggestion(folders: List<CloudFolder>): FilingSuggestion?

    /** Rename the sample's local entry. */
    suspend fun setTitle(title: String)

    /** File the sample's local entry; null is the root. */
    suspend fun setFolder(folderId: String?)

    /**
     * The offer is over — every half answered, or the user said no. After
     * this [pendingFilingSuggestion] answers null for good.
     */
    suspend fun answerSuggestion()
}
