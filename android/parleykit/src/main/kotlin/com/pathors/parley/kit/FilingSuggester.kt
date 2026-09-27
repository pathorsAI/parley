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
 * port of the desktop's `src/lib/ai/filing.ts`.
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
     * The same alias the dictation rewrite uses. One short label off an
     * already-transcribed conversation rides the cheap fast lane — exactly as the
     * desktop puts it on the "realtime" workload.
     */
    const val MODEL = "parley-fast"

    private const val TEMPERATURE = 0.2
    private const val MAX_TOKENS = 512

    /**
     * The standing instruction, kept word-for-word in sync with the desktop's
     * `SYSTEM` (`src/lib/ai/filing.ts`) and iOS `filingRules`: every platform
     * files the same person's recordings into the same folder registry, and drift
     * between them shows up as the phone and the Mac disagreeing about where a
     * meeting belongs.
     */
    val filingRules: String = """
        Given a finished meeting transcript, decide what the recording should be CALLED and where it should be FILED. Both doors into a recording name it badly — a live meeting arrives as "即時會議 · <date>" and an upload arrives as its file name — so this is usually the first honest title the recording gets.

        TITLE
        - Say what the meeting was ABOUT and, where it is clear, WITH WHOM: a company or a person plus the topic or the decision reached.
        - No date and no time. The library card already shows those, so spending the title on them wastes the only line the user reads.
        - No filler as the subject: "meeting", "recording", "call", "討論" and the like describe every recording in the library and therefore identify none of them. A title that would fit any meeting is a failed title.
        - Keep it short — roughly 10-24 characters of CJK, or about 4-8 English words.
        - If the current title is already specific and accurate, return it UNCHANGED. Churn for its own sake makes the library harder to trust, not easier.

        FOLDERS
        - The user's existing folders are listed below. Strongly prefer them. One folder is typically one customer/company or one ongoing workstream, so ask which of those this conversation belongs to.
        - Return 2-3 candidates ordered best-first. If only one is genuinely defensible, return one — a padded list is worse than a short one.
        - Copy an existing folder's name EXACTLY (character for character) when you mean that folder, and set isNew to false.
        - AT MOST ONE candidate may be a folder that does not exist yet (isNew: true), and only when no existing folder honestly fits. A new folder per meeting would grow the registry faster than the user can prune it.
        - reason is ONE short clause saying why the folder fits — it is shown as a tooltip, not read as prose.
        """.trimIndent()

    /**
     * The desktop gets its JSON out of the provider's schema-constrained mode;
     * here the shape has to be asked for in words.
     *
     * Deliberately NOT an OpenAI `response_format` parameter: nobody has verified
     * that the worker in front of the model passes it through, and a request
     * rejected for an unknown field costs the whole pass — while a model that
     * answers in prose costs nothing, because [parse] shrugs and the recording
     * keeps its name. [resolveFolders] has to survive a disobedient model anyway,
     * so the constraints are stated here and ENFORCED there.
     */
    val jsonInstruction: String = "\n\n" +
        "Return your answer strictly as a single JSON object and nothing else — no preamble, " +
        "no explanation, no code fences. Use these property names EXACTLY (verbatim): " +
        "{\"title\": string, \"folders\": [{\"name\": string, \"isNew\": boolean, \"reason\": string}]}."

    val systemPrompt: String = filingRules + jsonInstruction

    /**
     * A title longer than this is not a title. Loose enough to let a long but
     * honest title through, tight enough to catch a model that answered with a
     * sentence — or the meeting's summary — where a label was asked for.
     */
    const val MAXIMUM_TITLE_CHARACTERS = 80

    /**
     * How much transcript travels with the request. A meeting is not capped the
     * way dictation is, and an over-long request is not a worse suggestion, it is
     * a rejected request and no suggestion at all — so a long transcript is sent
     * as its head and its tail with the middle elided (see [capped]).
     */
    const val MAXIMUM_TRANSCRIPT_CHARACTERS = 24_000

    /**
     * Marked, not silent: the model should know it is reading an excerpt so it
     * does not conclude the meeting simply stopped mid-sentence.
     */
    const val ELISION_MARKER = "\n\n[… transcript trimmed …]\n\n"

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
     * @param speakerLabel the label a segment's speaker is shown under. Passed in
     *   because it is display copy (bilingual, and a name the user set wins), and
     *   the label the model reads should be the one the user reads.
     */
    suspend fun suggest(
        segments: List<TranscriptSegment>,
        speakerLabel: (TranscriptSegment) -> String,
        currentTitle: String,
        folders: List<FilingFolder>,
        chat: ChatCompletions,
    ): FilingSuggestion? {
        val rendered = transcript(segments, speakerLabel)
        if (rendered.isEmpty()) return null
        val excerpt = capped(rendered)

        val response = chat.chatCompletion(CloudChat.encode(request(currentTitle, folders, excerpt)))
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
    fun request(currentTitle: String, folders: List<FilingFolder>, transcript: String): CloudChat.Request =
        CloudChat.Request(
            model = MODEL,
            temperature = TEMPERATURE,
            maxTokens = MAX_TOKENS,
            messages = listOf(
                CloudChat.Message(role = "system", content = systemPrompt),
                CloudChat.Message(role = "user", content = userMessage(currentTitle, folders, transcript)),
            ),
        )

    /**
     * The context block, mirroring the desktop's prompt: what the recording is
     * called now (so the model can decline to rename it), the menu of existing
     * homes, then the conversation.
     */
    fun userMessage(currentTitle: String, folders: List<FilingFolder>, transcript: String): String {
        val named = currentTitle.trim().ifEmpty { "(untitled)" }
        return "The recording is currently called: $named\n\n" +
            folderMenu(folders) +
            "Transcript:\n$transcript"
    }

    /** Render the folder registry as the model's menu of existing homes. */
    fun folderMenu(folders: List<FilingFolder>): String {
        val names = personal(folders).map { it.name.trim() }.filter { it.isNotEmpty() }
        if (names.isEmpty()) {
            return "The user has NO folders yet, so every suggestion would have to be created — " +
                "return exactly ONE folder, with isNew: true.\n\n"
        }
        return "The user's existing folders:\n" + names.joinToString("\n") { "- $it" } + "\n\n"
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
     * Head + tail, with the middle marked as removed. Two thirds to the opening,
     * which has to carry who is in the room and what this is — most of a title —
     * and one third to the close, which carries how it ended.
     *
     * Counted in code points, and cut on code-point boundaries, so a cut never
     * lands inside a surrogate pair.
     */
    fun capped(transcript: String): String {
        val length = transcript.codePointCount(0, transcript.length)
        if (length <= MAXIMUM_TRANSCRIPT_CHARACTERS) return transcript
        val head = MAXIMUM_TRANSCRIPT_CHARACTERS * 2 / 3
        val tail = MAXIMUM_TRANSCRIPT_CHARACTERS - head
        val headEnd = transcript.offsetByCodePoints(0, head)
        val tailStart = transcript.offsetByCodePoints(transcript.length, -tail)
        return transcript.substring(0, headEnd) + ELISION_MARKER + transcript.substring(tailStart)
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
     * [transcript] is not read for content — only to answer "was this
     * conversation already in Simplified Chinese", so that a meeting conducted in
     * Simplified is not handed a rejection for a title that matches what was
     * said.
     */
    fun acceptTitle(candidate: String, currentTitle: String, transcript: String): Boolean {
        val trimmed = candidate.trim()
        if (trimmed.isEmpty()) return false
        if (trimmed.codePointCount(0, trimmed.length) > MAXIMUM_TITLE_CHARACTERS) return false
        // Simplified drift: renaming a Traditional Chinese meeting into
        // Simplified is the failure that looks like success. Only a NEWLY
        // introduced simplified character counts.
        val drifted = SimplifiedChinese.contains(trimmed) &&
            !SimplifiedChinese.contains(currentTitle) &&
            !SimplifiedChinese.contains(transcript)
        return !drifted
    }

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
