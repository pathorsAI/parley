package com.pathors.parley.kit

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The personal dictionary on disk — iOS `LexiconStore`, as an instance rather
 * than a static so tests can point it at a temporary file.
 *
 * `lexicon.json` in the app's files directory. iOS keeps the file in an App
 * Group because its keyboard is another process; Android's keyboard runs in the
 * app's own process, so the whole dictionary can also live in memory as a
 * [StateFlow] the screen observes, with the file as its durable copy. Every
 * write is a read-change-write under one lock, and atomic on disk (a sibling
 * temp file renamed over the old one), so a crash mid-write leaves the previous
 * dictionary rather than half of one.
 *
 * @param now the clock edits are stamped with; injectable for tests.
 */
class LexiconStore(
    private val file: File,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()
    private val _lexicon = MutableStateFlow(read())

    /** The dictionary as it is now. Updates after every write, sync's included. */
    val lexicon: StateFlow<Lexicon> = _lexicon.asStateFlow()

    /**
     * Called after every write. The app sets it to schedule a cloud sync after
     * a dictionary edit (`DictionarySyncModel`). Set once at startup, before
     * anything writes.
     */
    @Volatile
    var didSave: (() -> Unit)? = null

    fun load(): Lexicon = _lexicon.value

    fun save(lexicon: Lexicon) {
        synchronized(lock) { write(lexicon) }
        didSave?.invoke()
    }

    /** [save] without [didSave] — for sync, whose writes are already agreed with the cloud. */
    fun saveQuietly(lexicon: Lexicon) {
        synchronized(lock) { write(lexicon) }
    }

    /** See [Lexicon.recordConfirmed]. Returns whether the pair was stored. */
    fun recordConfirmed(original: String, replacement: String): Boolean {
        var stored = false
        mutate { lex -> lex.recordConfirmed(original, replacement, now())?.also { stored = true } ?: lex }
        return stored
    }

    /**
     * Replace one correction with another — the dictionary screen's edit.
     * Validated first, so a refused edit leaves the old row in place rather
     * than deleting it and storing nothing.
     */
    fun replacePair(oldOriginal: String, original: String, replacement: String): Boolean {
        var stored = false
        mutate { lex ->
            lex.removePair(oldOriginal).recordConfirmed(original, replacement, now())
                ?.also { stored = true } ?: lex
        }
        return stored
    }

    fun addTerm(text: String) = mutate { it.addTerm(text, now()) }

    /** Rename a term. A blank new text is ignored rather than read as a deletion. */
    fun replaceTerm(oldText: String, text: String) {
        if (text.isBlank()) return
        mutate { it.removeTerm(oldText).addTerm(text, now()) }
    }

    fun removePair(original: String) = mutate { it.removePair(original) }

    fun removeTerm(text: String) = mutate { it.removeTerm(text) }

    fun removeAll() = mutate { Lexicon() }

    /**
     * The terms recognition is biased toward ([Lexicon.recognitionTerms]): the
     * user's own words. Spent by every live relay (`hints.terms`) and every
     * batch job (`terms`), both capped at [ParleyStreamProtocol.VOCABULARY_LIMIT]
     * on the way out.
     */
    fun recognitionTerms(): List<String> = load().recognitionTerms

    private fun mutate(change: (Lexicon) -> Lexicon) {
        val changed = synchronized(lock) {
            val before = _lexicon.value
            val after = change(before)
            if (after != before) write(after)
            after != before
        }
        if (changed) didSave?.invoke()
    }

    private fun read(): Lexicon =
        runCatching { if (file.exists()) Lexicon.decode(file.readText()) else Lexicon() }.getOrDefault(Lexicon())

    /** Caller holds [lock]. A failed disk write still updates memory: the edit is not lost this run. */
    private fun write(lexicon: Lexicon) {
        _lexicon.value = lexicon
        runCatching { writeAtomically(file, lexicon.encode()) }
    }

    companion object {
        const val FILE_NAME = "lexicon.json"

        /** Write beside [target] and rename over it, so a reader never sees half a file. */
        internal fun writeAtomically(target: File, text: String) {
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, target.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                Files.deleteIfExists(tmp.toPath())
            }
        }
    }
}
