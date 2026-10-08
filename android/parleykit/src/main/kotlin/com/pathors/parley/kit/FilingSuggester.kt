package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * A folder as the filing pass sees it: enough to offer it as a home and to match
 * a model's answer back to it. The app maps its cloud folder type onto this, so
 * the pass itself stays free of the transport.
 *
 * [orgId] is non-null for an organization's shared folder, which the pass never
 * offers (see [FilingSuggester.personal]).
 */
data class FilingFolder(
    val id: String,
    val name: String,
    val orgId: String? = null,
    /**
     * Epoch ms of the folder's last change (the cloud's `updatedAt`, else its
     * `createdAt`), for ordering "the folders the user works in now". Null sorts
     * last. Only the sample's prewritten suggestion reads it
     * ([SampleManifest.filingSuggestion]); the filing pass does not.
     */
    val lastUsedAtMs: Double? = null,
)

/**
 * One candidate home for a recording. [folderId] is null when the model proposed
 * a folder the user does not have yet, which the caller must create before it
 * can file anything into it.
 */
data class FilingFolderSuggestion(
    val folderId: String?,
    val name: String,
    val reason: String,
)

/** What the filing pass proposes for one finished recording. */
data class FilingSuggestion(
    /** "" when the model had nothing better to propose than the current title. */
    val title: String,
    val folders: List<FilingFolderSuggestion>,
)

/**
 * The pass that runs once a recording has been transcribed: read the
 * conversation and say what the recording should be CALLED and where it should
 * be FILED. A port of iOS `ParleyKit/FilingSuggester.swift`, which is itself a
 * port of the desktop's `src/lib/ai/filing.ts`. The prompt text, the request
 * parameters and the limits all come from `shared/prompts/filing.json` via the
 * generated [FilingPrompt]; nothing prompt-shaped is defined here.
 *
 * Every door into a recording names it badly — on the phone a recording arrives
 * named after the clock — so this is usually the first honest title a recording
 * gets. It is also entirely optional: the recording already has a name and a
 * home, so a failure of any kind (no network, an unparsable answer, a model that
 * ignored the folder menu) resolves to "leave it exactly as it is". That is why
 * [suggest] returns null rather than an error the caller has to interpret, and
 * why nothing the model says is used before it has been through [acceptTitle]
 * and [resolveFolders].
 */
object FilingSuggester {
    /**
     * The standing instruction for [language]: the shared rules, the language
     * the title must be written in, then the JSON shape. Every Parley client
     * assembles exactly this from `shared/prompts/filing.json` (here via the
     * generated [FilingPrompt]), so the phone and the Mac read the same
     * conversation the same way and propose the same title.
     *
     * The desktop gets its JSON out of the provider's schema-constrained mode;
     * the phones ask for it in words ([FilingPrompt.JSON_INSTRUCTION]) and
     * deliberately send no OpenAI `response_format`: nobody has verified that
     * the worker in front of the model passes it through, and a request
     * rejected for an unknown field costs the whole pass — while a model that
     * answers in prose costs nothing, because [parse] shrugs and the recording
     * keeps its name. [resolveFolders] has to survive a disobedient model
     * anyway, so the constraints are stated in the prompt and ENFORCED there.
     */
    fun systemPrompt(language: FilingLanguage): String =
        FilingPrompt.RULES + language.instruction + FilingPrompt.JSON_INSTRUCTION

    private val json = Json { ignoreUnknownKeys = true }

    // ── the call ─────────────────────────────────────────────────────────────

    /**
     * Ask for a title and 2-3 folders for a finished recording.
     *
     * Returns null when there is nothing to read, when the answer could not be
     * parsed, or when nothing in it survived the gates — the caller keeps the
     * current title and leaves the recording where it is. Throws only on
     * transport/HTTP failure, which means the same thing to the caller.
     *
     * @param speakerLabel the label a segment's speaker is shown under — the
     *   name stored in the recording's `speakerNames` when there is one, which
     *   is what the desktop's `transcriptWithTimestamps` sends.
     * @param language the app's UI language; the title is written in it
     *   whatever language was spoken.
     * @param meetingContext the recording's `meetingContext`, "" for none.
     */
    suspend fun suggest(
        segments: List<TranscriptSegment>,
        speakerLabel: (TranscriptSegment) -> String,
        currentTitle: String,
        folders: List<FilingFolder>,
        chat: ChatCompletions,
        language: FilingLanguage,
        meetingContext: String = "",
    ): FilingSuggestion? {
        val rendered = transcript(segments, speakerLabel)
        if (rendered.isEmpty()) return null
        val excerpt = capped(rendered)

        val request = request(currentTitle, folders, excerpt, language, meetingContext)
        val response = chat.chatCompletion(CloudChat.encode(request))
        val payload = CloudChat.content(response)?.let(::parse) ?: return null

        val resolved = resolveFolders(payload.folders, folders)
        val candidate = payload.title.trim()
        // A title we will not use does not sink the folder suggestions with it:
        // the two halves fail independently, and half an answer is still worth
        // showing. Nothing left standing is the same as no answer.
        val title = if (acceptTitle(candidate, currentTitle, excerpt)) candidate else ""
        if (title.isEmpty() && resolved.isEmpty()) return null
        return FilingSuggestion(title = title, folders = resolved)
    }

    /** The request body, minus the transport. */
    fun request(
        currentTitle: String,
        folders: List<FilingFolder>,
        transcript: String,
        language: FilingLanguage,
        meetingContext: String = "",
    ): CloudChat.Request =
        CloudChat.Request(
            model = FilingPrompt.MODEL,
            temperature = FilingPrompt.TEMPERATURE,
            maxTokens = FilingPrompt.MAX_TOKENS,
            messages = listOf(
                CloudChat.Message(role = "system", content = systemPrompt(language)),
                CloudChat.Message(
                    role = "user",
                    content = userMessage(currentTitle, folders, transcript, meetingContext),
                ),
            ),
        )

    /**
     * The context block, in the order every client sends it: the meeting
     * context the user wrote (only when there is one), what the recording is
     * called now (so the model can decline to rename it), the menu of existing
     * homes, then the conversation.
     */
    fun userMessage(
        currentTitle: String,
        folders: List<FilingFolder>,
        transcript: String,
        meetingContext: String = "",
    ): String {
        val context = meetingContext.trim()
        val contextBlock = if (context.isEmpty()) "" else FilingPrompt.MEETING_CONTEXT_PREFIX + context + "\n\n"
        val named = currentTitle.trim().ifEmpty { FilingPrompt.UNTITLED }
        return contextBlock +
            FilingPrompt.CURRENT_TITLE_PREFIX + named + "\n\n" +
            folderMenu(folders) +
            FilingPrompt.TRANSCRIPT_HEADER + "\n" + transcript
    }

    /** Render the folder registry as the model's menu of existing homes. */
    fun folderMenu(folders: List<FilingFolder>): String {
        val names = personal(folders).map { it.name.trim() }.filter { it.isNotEmpty() }
        if (names.isEmpty()) return FilingPrompt.NO_FOLDERS + "\n\n"
        return FilingPrompt.FOLDERS_HEADER + "\n" + names.joinToString("\n") { "- $it" } + "\n\n"
    }

    /**
     * Filing is a personal-library action: an org's shared folders belong to a
     * workspace the user may only be able to read, and offering one as a home
     * would produce a suggestion that cannot be accepted.
     */
    fun personal(folders: List<FilingFolder>): List<FilingFolder> = folders.filter { it.orgId == null }

    // ── the transcript we send ───────────────────────────────────────────────

    /**
     * The transcript as the model reads it, in the desktop's
     * `transcriptWithTimestamps` shape: final segments only, oldest first, one
     * line of `[m:ss] [Speaker] text` each.
     */
    fun transcript(segments: List<TranscriptSegment>, speakerLabel: (TranscriptSegment) -> String): String =
        segments
            .filter { it.isFinal && it.text.isNotBlank() }
            .sortedBy { it.startMs }
            .joinToString("\n") { "[${clock(it.startMs)}] [${speakerLabel(it)}] ${it.text.trim()}" }

    /** A meeting-relative offset as m:ss, matching the desktop's `formatClock`. */
    fun clock(ms: Long): String {
        val seconds = ms / 1000
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    /**
     * Head + tail, with the middle marked as removed, once the transcript runs
     * past [FilingPrompt.MAX_TRANSCRIPT_CHARACTERS]: an over-long request is not
     * a worse suggestion, it is a rejected request and no suggestion at all.
     * The head's share ([FilingPrompt.HEAD_SHARE_NUMERATOR] /
     * [FilingPrompt.HEAD_SHARE_DENOMINATOR], two thirds) goes to the opening,
     * which has to carry who is in the room and what this is — most of a title
     * — and the rest to the close, which carries how it ended. The cut is
     * marked ([FilingPrompt.ELISION_MARKER]), not silent, so the model does not
     * conclude the meeting simply stopped mid-sentence.
     *
     * Counted in code points, and cut on code-point boundaries, so a cut never
     * lands inside a surrogate pair.
     */
    fun capped(transcript: String): String {
        val max = FilingPrompt.MAX_TRANSCRIPT_CHARACTERS
        val length = transcript.codePointCount(0, transcript.length)
        if (length <= max) return transcript
        val head = max * FilingPrompt.HEAD_SHARE_NUMERATOR / FilingPrompt.HEAD_SHARE_DENOMINATOR
        val tail = max - head
        val headEnd = transcript.offsetByCodePoints(0, head)
        val tailStart = transcript.offsetByCodePoints(transcript.length, -tail)
        return transcript.substring(0, headEnd) + FilingPrompt.ELISION_MARKER + transcript.substring(tailStart)
    }

    // ── what came back ───────────────────────────────────────────────────────

    /**
     * One folder as the model wrote it, before any of the product's rules have
     * been applied. A missing `isNew` or `reason` defaults rather than failing
     * the parse: the row still names a folder.
     */
    data class RawFolder(val name: String, val isNew: Boolean = false, val reason: String = "")

    /** The whole object as the model wrote it. */
    data class RawSuggestion(val title: String, val folders: List<RawFolder>)

    /**
     * Decode the answer, forgiving the packaging: JSON in a code fence, or after
     * a line of "Sure, here's the suggestion:", is still a good suggestion, so the
     * first balanced object in the reply is what gets decoded. A reply with no
     * object in it at all is null — the caller's cue to leave the recording alone.
     */
    fun parse(content: String): RawSuggestion? {
        val text = firstJsonObject(content) ?: return null
        val obj = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
        val folders = (obj["folders"] as? JsonArray)
            ?.mapNotNull { (it as? JsonObject)?.let(::rawFolder) }
            .orEmpty()
        return RawSuggestion(title = obj.string("title").orEmpty(), folders = folders)
    }

    private fun rawFolder(obj: JsonObject): RawFolder = RawFolder(
        name = obj.string("name").orEmpty(),
        isNew = (obj["isNew"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: false,
        reason = obj.string("reason").orEmpty(),
    )

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /**
     * The first balanced `{…}` in [s], braces inside string literals ignored.
     * Brace counting rather than a regex because a `reason` is free text and may
     * well contain a brace of its own. Unbalanced — a truncated answer, or a stray
     * brace in a preamble — is null: there is no object there to trust.
     */
    fun firstJsonObject(s: String): String? {
        val start = s.indexOf('{')
        if (start < 0) return null
        val scanner = BraceScanner()
        for (i in start until s.length) {
            if (scanner.closesObject(s[i])) return s.substring(start, i + 1)
        }
        return null
    }

    /** The state [firstJsonObject] carries from one character to the next. */
    private class BraceScanner {
        private var depth = 0
        private var inString = false
        private var escaped = false

        /** Feed one character; true when it closes the outermost object. */
        fun closesObject(c: Char): Boolean {
            if (inString) {
                readStringCharacter(c)
                return false
            }
            when (c) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> {
                    depth--
                    return depth == 0
                }
            }
            return false
        }

        private fun readStringCharacter(c: Char) {
            when {
                escaped -> escaped = false
                c == '\\' -> escaped = true
                c == '"' -> inString = false
            }
        }
    }

    // ── what we are willing to show ──────────────────────────────────────────

    /**
     * Whether [candidate] is a title we are willing to put in front of the user.
     * The model is not trusted to have followed the prompt.
     *
     * Refused: an empty title; one longer than
     * [FilingPrompt.MAX_TITLE_CHARACTERS] code points (a sentence, or the
     * meeting's summary, where a label was asked for); the title the recording
     * already has (nothing to propose); and one containing a Simplified-only
     * character that appears in neither the current title nor the transcript.
     *
     * [transcript] is not read for content — only to answer "was this
     * conversation already in Simplified Chinese", so that a meeting conducted in
     * Simplified is not handed a rejection for a title that matches what was
     * said.
     */
    fun acceptTitle(candidate: String, currentTitle: String, transcript: String): Boolean {
        val trimmed = candidate.trim()
        if (trimmed.isEmpty()) return false
        if (trimmed.codePointCount(0, trimmed.length) > FilingPrompt.MAX_TITLE_CHARACTERS) return false
        if (trimmed == currentTitle.trim()) return false
        // Simplified drift: renaming a Traditional Chinese meeting into
        // Simplified is the failure that looks like success. Judged per
        // character, the same on every platform: a Simplified-only character
        // (FilingPrompt.SIMPLIFIED_ONLY_CHARS) is drift unless that very
        // character is already in the current title or the transcript as sent.
        return trimmed.codePoints().noneMatch { cp ->
            cp in simplifiedOnly && !currentTitle.containsCodePoint(cp) && !transcript.containsCodePoint(cp)
        }
    }

    /** [FilingPrompt.SIMPLIFIED_ONLY_CHARS] as code points. */
    private val simplifiedOnly: Set<Int> = FilingPrompt.SIMPLIFIED_ONLY_CHARS.codePoints().toArray().toSet()

    private fun String.containsCodePoint(cp: Int): Boolean = indexOf(String(Character.toChars(cp))) >= 0

    /**
     * Turn the model's raw folder picks into suggestions the UI can act on — a
     * faithful port of the desktop's `resolveFilingFolders`. This is where the
     * product's rules actually live: a filing suggestion that quietly creates
     * three folders is worse than none, so nothing here trusts the model.
     *
     * - At most three, in the model's (best-first) order.
     * - A blank name names no folder and is dropped.
     * - A name matching an existing personal folder (trimmed, case-insensitive)
     *   files into it under the registry's spelling, whatever `isNew` claimed;
     *   repeats of the same folder are noise.
     * - Only the FIRST unmatched name survives, as a folder to create.
     */
    fun resolveFolders(raw: List<RawFolder>, folders: List<FilingFolder>): List<FilingFolderSuggestion> {
        val byName = indexByName(personal(folders))
        val out = mutableListOf<FilingFolderSuggestion>()
        val seenIds = mutableSetOf<String>()
        var newTaken = false

        for (entry in raw) {
            if (out.size >= MAXIMUM_FOLDER_SUGGESTIONS) break
            val name = entry.name.trim()
            if (name.isEmpty()) continue
            val reason = entry.reason.trim()
            val match = byName[name.lowercase()]
            if (match != null) {
                if (seenIds.add(match.id)) out += FilingFolderSuggestion(match.id, match.name, reason)
            } else if (!newTaken) {
                newTaken = true
                out += FilingFolderSuggestion(folderId = null, name = name, reason = reason)
            }
        }
        return out
    }

    /** The UI has room for three chips. */
    private const val MAXIMUM_FOLDER_SUGGESTIONS = 3

    /**
     * Index the registry by trimmed, lowercased name. "Acme Corp" vs "acme corp "
     * is the model being sloppy about spelling, not the user wanting a second
     * folder. First occurrence wins, so two folders sharing a name resolve to the
     * older one.
     */
    private fun indexByName(folders: List<FilingFolder>): Map<String, FilingFolder> {
        val byName = LinkedHashMap<String, FilingFolder>()
        for (folder in folders) {
            val key = folder.name.trim().lowercase()
            if (key.isNotEmpty()) byName.putIfAbsent(key, folder)
        }
        return byName
    }
}
