package com.pathors.parley.filing

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
 * `SampleRecordingStore` is expected to implement this (its
 * `suggestionPending` flag and the manifest's `filingSuggestion()` are the
 * onboarding-v2 data layer); until it does, [com.pathors.parley.AppContainer.sampleFiling]
 * is null and the sample simply shows no card. Nothing else has to change
 * for it to plug in.
 */
interface SampleFilingTarget {

    /**
     * The sample's suggestion while it is still waiting on an answer, or null
     * once it has been answered (accepted in full, or skipped) — or when the
     * sample has none.
     */
    suspend fun pendingFilingSuggestion(): FilingSuggestion?

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
