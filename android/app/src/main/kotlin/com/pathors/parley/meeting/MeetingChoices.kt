package com.pathors.parley.meeting

import com.pathors.parley.library.SaveDestination
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * A folder picked on the record screen for the meeting, with the label the
 * picker drew it under (the chip shows that, not a lookup). iOS
 * `MeetingRecorder.ChosenFolder`.
 */
data class ChosenFolder(val destination: SaveDestination, val label: String)

/**
 * What the user said about the next (or the current) meeting on the record
 * screen: its name and where it goes. iOS `MeetingRecorder.meetingTitle` and
 * `meetingFolder`, which the desktop's meeting window saves the same way.
 *
 * Saved straight into when the meeting ends ([MeetingSession] reads them at
 * save time, so a name typed in the last minute counts): a choice that waited
 * for the filing card after End would be lost to a locked phone or a failed
 * pass.
 */
data class MeetingChoices(
    /** As typed. Blank lands the recording under its clock name, as before. */
    val title: String = "",
    /** Null = the app's default destination (the "Default save location" setting). */
    val folder: ChosenFolder? = null,
    /**
     * The context the meeting was prepared with: a meeting draft's 補充背景,
     * when it was started from one. Not shown on the record screen; saved
     * into the recording's `meetingContext`, as the desktop's meeting carries
     * its prep's (`prepFromDraft`). Blank for a meeting started any other way.
     * iOS `MeetingRecorder.meetingContext`.
     */
    val meetingContext: String = "",
    /**
     * The meeting draft this meeting was started from, or null. Once the
     * meeting is recording the draft is hidden on this phone
     * ([com.pathors.parley.library.StartedDrafts]) — never deleted: the phone
     * only reads drafts.
     */
    val draftId: String? = null,
) {
    /** The name the recording is saved under, or null for its clock name. */
    val typedTitle: String? get() = title.trim().takeIf { it.isNotEmpty() }

    /** The user named the meeting — the filing pass proposes no title over it. */
    val named: Boolean get() = typedTitle != null

    /** The user picked its folder — the filing pass does not second-guess it. */
    val filed: Boolean get() = folder != null
}

/**
 * The record screen's [MeetingChoices], process-wide like
 * [MeetingService.activeSession]: they are made *before* a meeting exists (the
 * screen before Start is where the next meeting is named and filed), kept
 * through the start, and cleared once the meeting they belong to is saved —
 * so the next meeting starts unnamed and unfiled.
 */
object MeetingDraft {
    private val _choices = MutableStateFlow(MeetingChoices())
    val choices: StateFlow<MeetingChoices> = _choices.asStateFlow()

    fun setTitle(title: String) = _choices.update { it.copy(title = title) }

    fun setFolder(folder: ChosenFolder?) = _choices.update { it.copy(folder = folder) }

    /** Saved under them (or kept on the phone under them): forget them. */
    fun clear() {
        _choices.value = MeetingChoices()
    }

    /**
     * A meeting draft's 開始: the draft's name, folder and context become the
     * next meeting's — the desktop's `takeDraft`, which loads the draft into
     * the prep before the meeting starts. Replaces whatever was there.
     */
    fun takeDraft(choices: MeetingChoices) {
        _choices.value = choices
    }

    /**
     * A start from a draft that did not get going (the microphone refused,
     * and the user backed out): let the draft's choices go, so the next
     * meeting is not quietly filed under a draft it was not started from.
     * Choices typed on the record screen are left alone.
     */
    fun dropDraft() = _choices.update { if (it.draftId != null) MeetingChoices() else it }

    /** The screenshot demo's meeting, named and filed on the record screen. */
    fun seed(choices: MeetingChoices) {
        _choices.value = choices
    }
}
