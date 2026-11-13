package com.pathors.parley.kit

import java.io.File
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// Personal-dictionary sync with Parley Cloud — iOS `DictionarySync.swift`, and
// the desktop's `src/lib/cloud/dictionarySync.ts`, over the same contract
// (`GET` / `PUT /v1/dictionary`, parley-internal `apps/cloud/src/dictionary.ts`).
//
// The cloud keeps one entry per PHRASE: the correct written form plus the
// misheard forms that get rewritten into it. The phone's lexicon has no such
// entries, so it is projected into them ([DictionarySync.project]):
//
//   - a term the user added → an entry with no variants, source `manual`;
//   - a CONFIRMED correction → its `original` becomes a variant of the entry
//     whose phrase is its `replacement`, source `learned`;
//   - a term and corrections that share a phrase are one entry.
//
// Never projected, so never sent: corrections still being learned.
//
// Changes are found by diffing that projection against a snapshot of the
// cloud's state and of how much of it this phone held
// ([DictionarySyncState.synced]).
//
// The one rule that keeps a phone from costing the account data: it only ever
// removes what it held and the user removed. Every push carries the variants it
// never held unchanged, a phrase it never held is never pushed or deleted, and a
// phrase the user removed here is a tombstone only if the phone held all of it.
//
// Free of I/O except [DictionarySync.run], which takes its network
// ([DictionarySyncTransport]) and its files ([DictionarySyncStorage]) as
// arguments, so the whole thing runs under plain JUnit.

/** An entry as `GET` / `PUT /v1/dictionary` exchange it. */
@Serializable
data class CloudDictionaryEntry(
    val id: String,
    val phrase: String,
    val variants: List<String> = emptyList(),
    /** `manual` | `learned` | `imported`. */
    val source: String = DictionarySync.SOURCE_MANUAL,
    val confirmed: Boolean = true,
    /** Epoch ms of the last change — the last-write-wins clock. */
    val updatedAt: Long = 0,
    /** Epoch ms of the deletion; null = live. Omitted from the wire when null. */
    val deletedAt: Long? = null,
)

/** One refused entry of a PUT; [index] is its position in that request. */
@Serializable
data class CloudDictionaryRejection(val index: Int, val id: String = "", val error: String = "")

@Serializable
data class DictionaryPullResponse(
    val entries: List<CloudDictionaryEntry> = emptyList(),
    /** Server time — the `since` of the next pull. */
    val now: Long = 0,
)

@Serializable
data class DictionaryPushResponse(
    val entries: List<CloudDictionaryEntry> = emptyList(),
    val rejected: List<CloudDictionaryRejection> = emptyList(),
)

/** The two calls sync makes. `CloudClient` is the real one; tests use a fake. */
interface DictionarySyncTransport {
    suspend fun pullDictionary(since: Long?): DictionaryPullResponse
    suspend fun pushDictionary(entries: List<CloudDictionaryEntry>): DictionaryPushResponse
}

/**
 * The cloud's state of a phrase as of the last sync, and how much of it this
 * phone holds.
 *
 * The phone cannot always hold all of a phrase: a variant may be one it refuses
 * as a correction (a single CJK character), or the caps may have evicted part
 * or all of it. So the snapshot keeps the FULL variant list the cloud has, and
 * separately what the phone held of it.
 *
 * @property variants every variant the cloud has for the phrase.
 * @property held the subset of [variants] this phone held as confirmed corrections.
 * @property heldPhrase whether this phone held the phrase at all.
 * @property source the cloud's `source`, sent back on a deletion.
 */
@Serializable
data class DictionarySynced(
    val id: String,
    val variants: List<String> = emptyList(),
    val held: List<String> = variants,
    val heldPhrase: Boolean = true,
    val source: String = DictionarySync.SOURCE_MANUAL,
)

/**
 * What sync remembers between runs, per account.
 *
 * @property userId the account the snapshot belongs to — another account starts over.
 * @property cursor the previous successful pull's `now`; null = never synced.
 * @property pendingDeletes phrase → when this phone first noticed it gone.
 * @property parked phrase → fingerprint of a local form the cloud refused for good.
 * @property clearedAt when the user last chose "Clear the dictionary", until a
 *   sync carries it out — lets a deliberate clear through the empty-dictionary guard.
 * @property lastSyncedAt when the last run finished cleanly, for the status line.
 */
@Serializable
data class DictionarySyncState(
    val userId: String? = null,
    val cursor: Long? = null,
    val synced: Map<String, DictionarySynced> = emptyMap(),
    val pendingDeletes: Map<String, Long> = emptyMap(),
    val parked: Map<String, String> = emptyMap(),
    val clearedAt: Long? = null,
    val lastSyncedAt: Long? = null,
    val lastFailed: Boolean = false,
)

/** Where [DictionarySync.run] reads and writes. [FileDictionarySyncStorage] is the real one. */
interface DictionarySyncStorage {
    fun loadLexicon(): Lexicon
    fun saveLexicon(lexicon: Lexicon)
    fun loadState(): DictionarySyncState?
    fun saveState(state: DictionarySyncState)
}

object DictionarySync {
    const val SOURCE_MANUAL = "manual"
    const val SOURCE_LEARNED = "learned"

    /** The server's per-request cap. */
    const val PUSH_BATCH = 500

    /**
     * An empty projection where the snapshot remembers at least this many
     * phrases is taken for a lost file, not a wipe — same rule as the desktop.
     */
    const val RESET_GUARD_MIN = 10

    /** Refusals that go away on their own; any other code is final for that form. */
    private val transientRejections = setOf("conflict", "entry_limit")

    private const val ABSENT = "-"
    private const val SEPARATOR = "\u001F"

    // ── projection ───────────────────────────────────────────────────────────

    /** One phrase as the phone holds it. [variants] is sorted so the diff ignores order. */
    data class Projected(
        val phrase: String,
        val variants: List<String>,
        val source: String,
        val updatedAt: Long,
    )

    /** The lexicon as cloud entries, keyed by phrase. See the file header. */
    fun project(lexicon: Lexicon): Map<String, Projected> {
        val out = linkedMapOf<String, Projected>()
        for (term in lexicon.terms) {
            val phrase = term.text.trim()
            if (phrase.isEmpty()) continue
            val existing = out[phrase]
            out[phrase] = existing?.copy(updatedAt = maxOf(existing.updatedAt, term.updatedAt))
                ?: Projected(phrase, emptyList(), SOURCE_MANUAL, term.updatedAt)
        }
        for (pair in lexicon.pairs) {
            if (!pair.isConfirmed) continue
            val phrase = pair.replacement.trim()
            val original = pair.original.trim()
            if (phrase.isEmpty() || original.isEmpty() || original == phrase) continue
            val p = out[phrase] ?: Projected(phrase, emptyList(), SOURCE_LEARNED, 0)
            out[phrase] = p.copy(
                variants = if (original in p.variants) p.variants else p.variants + original,
                updatedAt = maxOf(p.updatedAt, pair.updatedAt),
            )
        }
        return out.mapValues { (_, p) -> p.copy(variants = p.variants.sorted()) }
    }

    /**
     * Whether the phone can hold `variant → phrase` as a correction. The
     * desktop has no such rules, so a variant it learned can be one the phone
     * refuses; those are carried through untouched rather than read as deleted.
     */
    fun representable(variant: String, phrase: String): Boolean = Lexicon.problem(variant, phrase) == null

    internal fun fingerprint(p: Projected?): String =
        if (p == null) ABSENT else "+" + p.variants.joinToString(SEPARATOR)

    /** The fingerprint a phrase has locally when nothing changed here since the last sync. */
    internal fun syncedFingerprint(state: DictionarySyncState, phrase: String): String {
        val s = state.synced[phrase]?.takeIf { it.heldPhrase } ?: return ABSENT
        return "+" + s.held.sorted().joinToString(SEPARATOR)
    }

    // ── outgoing ─────────────────────────────────────────────────────────────

    /**
     * @property sentFrom phrase → fingerprint of the local state the entry was built from.
     * @property released phrases the user removed here that still carry variants
     *   this phone never held: they go up live with only those, and the phone
     *   lets go of them rather than writing them back.
     * @property reset the empty-dictionary guard set the snapshot aside.
     */
    data class Outgoing(
        val entries: List<CloudDictionaryEntry>,
        val sentFrom: Map<String, String>,
        val pendingDeletes: Map<String, Long>,
        val released: Set<String>,
        val reset: Boolean,
    )

    /**
     * What has to go up: one entry per phrase that is new or changed here, and
     * one per phrase the user removed here.
     *
     * Guard: a dictionary that is suddenly EMPTY while the snapshot remembers
     * [RESET_GUARD_MIN] or more phrases held here is a lost file far more often
     * than a deliberate wipe, and pushing it as deletions would empty the
     * desktop too. Unless the user chose "Clear the dictionary" (`clearedAt`),
     * the snapshot is set aside and the merge brings the entries back.
     */
    fun outgoing(
        projection: Map<String, Projected>,
        state: DictionarySyncState,
        now: Long,
        newId: () -> String = { UUID.randomUUID().toString().lowercase(Locale.ROOT) },
    ): Outgoing {
        val heldCount = state.synced.values.count { it.heldPhrase }
        val reset = projection.isEmpty() && heldCount >= RESET_GUARD_MIN && state.clearedAt == null
        val entries = mutableListOf<CloudDictionaryEntry>()
        val sentFrom = mutableMapOf<String, String>()

        for (phrase in projection.keys.sorted()) {
            val p = projection.getValue(phrase)
            val fp = fingerprint(p)
            if (fp == syncedFingerprint(state, phrase) || state.parked[phrase] == fp) continue
            val synced = state.synced[phrase]
            entries += CloudDictionaryEntry(
                id = synced?.id ?: newId(),
                phrase = phrase,
                variants = merged(p.variants, synced),
                source = p.source,
                updatedAt = p.updatedAt,
            )
            sentFrom[phrase] = fp
        }

        val removals = if (reset) {
            emptyList()
        } else {
            state.synced.keys.sorted().filterNot(projection::containsKey).mapNotNull { removal(it, state, now) }
        }
        val pendingDeletes = mutableMapOf<String, Long>()
        val released = mutableSetOf<String>()
        for (removal in removals) {
            entries += removal
            pendingDeletes[removal.phrase] = removal.updatedAt
            if (removal.deletedAt == null) released += removal.phrase
            sentFrom[removal.phrase] = ABSENT
        }
        return Outgoing(entries, sentFrom, pendingDeletes, released, reset)
    }

    /**
     * The entry for a phrase the user removed here, stamped with when this
     * phone first noticed — or null for one it never held. A tombstone only
     * when the phone held all of it; otherwise it goes up live with just the
     * variants the phone never held, so a deletion cannot reach past what the
     * user saw.
     */
    private fun removal(phrase: String, state: DictionarySyncState, now: Long): CloudDictionaryEntry? {
        val synced = state.synced.getValue(phrase)
        if (!synced.heldPhrase) return null
        val at = state.pendingDeletes[phrase] ?: state.clearedAt ?: now
        val unheld = merged(emptyList(), synced)
        return CloudDictionaryEntry(
            id = synced.id,
            phrase = phrase,
            variants = unheld,
            source = synced.source,
            updatedAt = at,
            deletedAt = if (unheld.isEmpty()) at else null,
        )
    }

    /**
     * The variants to send for a phrase: what is held here now, then every
     * variant the cloud had that the phone never held, in the cloud's order.
     */
    internal fun merged(local: List<String>, synced: DictionarySynced?): List<String> {
        if (synced == null) return local
        val held = synced.held.toSet()
        val out = local.toMutableList()
        for (v in synced.variants) if (v !in held && v !in out) out += v
        return out
    }

    // ── applying ─────────────────────────────────────────────────────────────

    /** A refusal from a push, resolved back to its phrase. */
    data class Rejection(val phrase: String, val error: String)

    /**
     * One exchange with the cloud.
     *
     * @property pulled rows from the pull: other devices' changes, plus echoes of ours.
     * @property pushed the merged rows the pushes answered with.
     */
    data class Exchange(
        val pulled: List<CloudDictionaryEntry>,
        val pushed: List<CloudDictionaryEntry>,
        val rejected: List<Rejection> = emptyList(),
    )

    /** What [apply] returns: the lexicon to write (null when unchanged) and the new snapshot. */
    data class Applied(val lexicon: Lexicon?, val state: DictionarySyncState)

    /**
     * Fold an exchange into the CURRENT lexicon (re-read after the network
     * round trip — the user may have edited in the meantime) and the snapshot.
     *
     * A pulled row only touches a phrase still untouched here; a pushed row only
     * one that looks exactly as it did when it was sent. Anything edited in
     * between is left for the next run.
     */
    fun apply(lexicon: Lexicon, state: DictionarySyncState, outgoing: Outgoing, exchange: Exchange): Applied {
        val projection = project(lexicon)
        fun current(phrase: String) = fingerprint(projection[phrase])

        val synced = (if (outgoing.reset) emptyMap() else state.synced).toMutableMap()
        val pendingDeletes = outgoing.pendingDeletes.toMutableMap()
        val parked = state.parked.toMutableMap()
        val base = state.copy(synced = synced)

        // Pushed rows after pulled ones: the push's answer is the newer word.
        val rows = sortedMapOf<String, CloudDictionaryEntry>()
        exchange.pulled.filter { acceptsPulled(it, outgoing, base, current(it.phrase)) }.forEach { rows[it.phrase] = it }
        exchange.pushed.filter { outgoing.sentFrom[it.phrase] == current(it.phrase) }.forEach { rows[it.phrase] = it }
        for (rejection in exchange.rejected) {
            val fp = outgoing.sentFrom[rejection.phrase]
            if (rejection.error in transientRejections || fp == null || fp != current(rejection.phrase)) continue
            settleRefusal(rejection.phrase, fp, projection.containsKey(rejection.phrase), synced, pendingDeletes, parked)
        }
        val folded = state.copy(synced = synced, pendingDeletes = pendingDeletes, parked = parked)
        if (rows.isEmpty()) return Applied(null, folded)

        rows.keys.forEach {
            pendingDeletes.remove(it)
            parked.remove(it)
        }
        // Caps, as every other write to the lexicon is held to them.
        val lex = rows.values.fold(lexicon) { acc, row -> fold(row, acc, outgoing.released) }.evicted()

        // The snapshot keeps the cloud's whole row, and records what the phone
        // actually ended up holding of it — so neither a refused variant nor one
        // the caps evicted can ever be read as a deletion made here.
        val after = project(lex)
        for ((phrase, row) in rows) {
            if (row.deletedAt != null) synced.remove(phrase) else synced[phrase] = snapshot(row, after[phrase])
        }
        val next = state.copy(synced = synced, pendingDeletes = pendingDeletes, parked = parked)
        return Applied(if (lex == lexicon) null else lex, next)
    }

    /** The snapshot of a live row: the cloud's whole variant list, and what of it the phone holds. */
    private fun snapshot(row: CloudDictionaryEntry, held: Projected?) = DictionarySynced(
        id = row.id,
        variants = row.variants,
        held = held?.variants?.filter { it in row.variants }.orEmpty(),
        heldPhrase = held != null,
        source = row.source,
    )

    /** One accepted row into the lexicon. */
    private fun fold(row: CloudDictionaryEntry, lexicon: Lexicon, released: Set<String>): Lexicon = when {
        row.deletedAt != null -> lexicon.copy(
            terms = lexicon.terms.filterNot { it.text == row.phrase },
            pairs = lexicon.pairs.filterNot { it.replacement == row.phrase && it.isConfirmed },
        )
        // A released phrase is one the user removed here; what is left of it
        // in the cloud is not written back.
        row.phrase in released -> lexicon
        else -> write(row, lexicon)
    }

    /**
     * A form the cloud will never take: a live phrase is parked under that
     * form, so it is not offered again until it changes; a deletion it refused
     * is dropped from the snapshot, there being nothing left here to delete.
     */
    private fun settleRefusal(
        phrase: String,
        fingerprint: String,
        live: Boolean,
        synced: MutableMap<String, DictionarySynced>,
        pendingDeletes: MutableMap<String, Long>,
        parked: MutableMap<String, String>,
    ) {
        if (live) {
            parked[phrase] = fingerprint
        } else {
            synced.remove(phrase)
            pendingDeletes.remove(phrase)
        }
    }

    /**
     * Whether a pulled row may touch its phrase: not one this run is pushing,
     * not one edited here since the last sync, and not a pure echo of what is
     * already agreed — re-applying that would bring back a phrase the phone let
     * go of, or re-run caps that already evicted it.
     */
    private fun acceptsPulled(
        row: CloudDictionaryEntry,
        outgoing: Outgoing,
        state: DictionarySyncState,
        currentFingerprint: String,
    ): Boolean {
        if (outgoing.sentFrom.containsKey(row.phrase)) return false
        if (currentFingerprint != syncedFingerprint(state, row.phrase)) return false
        val known = state.synced[row.phrase] ?: return true
        val echo = row.deletedAt == null && known.id == row.id && known.variants.toSet() == row.variants.toSet()
        return !echo
    }

    /**
     * Make the lexicon hold [row]: its variants as confirmed corrections, and a
     * term when the row is a plain term, was typed in by hand, or carries
     * nothing the phone can hold as a correction.
     */
    internal fun write(row: CloudDictionaryEntry, lexicon: Lexicon): Lexicon {
        val phrase = row.phrase
        val variants = row.variants.filter { representable(it, phrase) }.distinct()
        // Confirmed corrections into this phrase that the row no longer has.
        // Ones still being learned are this phone's guesses and never went up.
        val pairs = lexicon.pairs
            .filterNot { it.replacement == phrase && it.isConfirmed && it.original !in variants }
            .toMutableList()
        for (v in variants) {
            val i = pairs.indexOfFirst { it.original == v }
            when {
                i < 0 -> pairs += LexiconPair(v, phrase, Lexicon.AUTO_APPLY_THRESHOLD, row.updatedAt)
                pairs[i].replacement == phrase ->
                    pairs[i] = pairs[i].copy(count = maxOf(pairs[i].count, Lexicon.AUTO_APPLY_THRESHOLD))
                // The cloud's mapping wins over this phone's for the same
                // misheard form — it is the newer word on the matter.
                else -> pairs[i] = LexiconPair(v, phrase, Lexicon.AUTO_APPLY_THRESHOLD, row.updatedAt)
            }
        }
        val needsTerm = lexicon.terms.none { it.text == phrase } &&
            (variants.isEmpty() || row.source == SOURCE_MANUAL)
        val terms = if (needsTerm) lexicon.terms + LexiconTerm(phrase, row.updatedAt) else lexicon.terms
        return Lexicon(pairs, terms)
    }

    // ── running ──────────────────────────────────────────────────────────────

    sealed interface Outcome {
        data class Synced(val pulled: Int, val pushed: Int, val refused: Int) : Outcome
        data class Failed(val reason: String) : Outcome
    }

    /** Whether the lexicon differs from what was last synced — cheap enough to ask after every write. */
    fun hasLocalChanges(storage: DictionarySyncStorage, userId: String): Boolean {
        val state = loadState(storage, userId)
        return outgoing(project(storage.loadLexicon()), state, now = 0).entries.isNotEmpty()
    }

    internal fun loadState(storage: DictionarySyncStorage, userId: String): DictionarySyncState {
        val saved = storage.loadState() ?: return DictionarySyncState(userId = userId)
        if (saved.userId == userId) return saved
        // Another account: start over, but a clear the user asked for is still
        // theirs to carry out.
        return DictionarySyncState(userId = userId, clearedAt = saved.clearedAt)
    }

    /**
     * One full sync: pull, push, fold the result in, save. A failure writes
     * nothing to the lexicon and keeps the cursor, so the next trigger simply
     * tries again.
     */
    suspend fun run(
        userId: String,
        transport: DictionarySyncTransport,
        storage: DictionarySyncStorage,
        now: () -> Long = System::currentTimeMillis,
    ): Outcome {
        var state = loadState(storage, userId)
        val clearedAtStart = state.clearedAt
        val out = outgoing(project(storage.loadLexicon()), state, now())
        // Pinned before the network, so a failed run retries with the same times.
        state = state.copy(pendingDeletes = out.pendingDeletes)
        storage.saveState(state)

        return try {
            val pulled = transport.pullDictionary(if (out.reset) null else state.cursor)
            val pushed = mutableListOf<CloudDictionaryEntry>()
            val rejected = mutableListOf<Rejection>()
            for (batch in out.entries.chunked(PUSH_BATCH)) {
                val response = transport.pushDictionary(batch)
                pushed += response.entries
                response.rejected.forEach { r ->
                    batch.getOrNull(r.index)?.let { rejected += Rejection(it.phrase, r.error) }
                }
            }

            val applied = apply(storage.loadLexicon(), state, out, Exchange(pulled.entries, pushed, rejected))
            applied.lexicon?.let(storage::saveLexicon)
            // The clear this run carried out is done; one made while it was in
            // flight still has to go up next time.
            val latestClear = storage.loadState()?.clearedAt
            storage.saveState(
                applied.state.copy(
                    cursor = pulled.now,
                    lastSyncedAt = now(),
                    lastFailed = false,
                    clearedAt = if (latestClear == clearedAtStart) null else latestClear,
                ),
            )
            Outcome.Synced(pulled.entries.size, out.entries.size, rejected.size)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            storage.saveState(state.copy(lastFailed = true))
            Outcome.Failed(e.toString())
        }
    }
}

/**
 * The sync snapshot on disk, `lexicon-sync.json`, beside `lexicon.json` — on
 * purpose: storage that loses one loses both, so a snapshot can never outlive
 * the dictionary it describes and read the loss as a thousand deletions.
 */
class FileDictionarySyncStorage(
    private val store: LexiconStore,
    private val file: File,
) : DictionarySyncStorage {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    override fun loadLexicon(): Lexicon = store.load()

    /**
     * Written without firing [LexiconStore.didSave]'s sync-scheduling: what a
     * sync writes is already agreed with the cloud. (It would find nothing to
     * send anyway; this just saves the check.)
     */
    override fun saveLexicon(lexicon: Lexicon) = store.saveQuietly(lexicon)

    @Synchronized
    override fun loadState(): DictionarySyncState? = runCatching {
        if (file.exists()) json.decodeFromString(DictionarySyncState.serializer(), file.readText()) else null
    }.getOrNull()

    @Synchronized
    override fun saveState(state: DictionarySyncState) {
        runCatching { LexiconStore.writeAtomically(file, json.encodeToString(DictionarySyncState.serializer(), state)) }
    }

    /**
     * The user chose "Clear the dictionary": remember it, so the next sync
     * carries the clear out instead of the empty-dictionary guard undoing it.
     */
    @Synchronized
    fun noteCleared(now: Long = System.currentTimeMillis()) {
        saveState((loadState() ?: DictionarySyncState()).copy(clearedAt = now))
    }

    companion object {
        const val FILE_NAME = "lexicon-sync.json"
    }
}
