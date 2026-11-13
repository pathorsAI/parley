package com.pathors.parley.kit

import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_790_000_000_000L
private const val T0 = NOW - 10_000
private const val USER = "u1"
private const val PARLEY = "Parley"
private const val HEARD = "怕理"
private const val HEARD_2 = "帕力"
private const val LEARNED = DictionarySync.SOURCE_LEARNED
private const val PARTY = "派對"
private const val QUEUE = "排隊"
private const val LONE = "派"

/**
 * Personal-dictionary sync: the projection, the diff, the merge back into the
 * lexicon, and a full run against a fake cloud. Case for case the iOS suite
 * (`ParleyKitTests/DictionarySyncTests.swift`), which itself mirrors the
 * desktop's `dictionarySync.test.ts` — so the three clients agree on every rule
 * that can cost an account its data.
 */
class DictionarySyncTest {
    private val threshold = Lexicon.AUTO_APPLY_THRESHOLD

    private fun confirmed(original: String, replacement: String, at: Long = T0) =
        LexiconPair(original, replacement, threshold, at)

    private fun row(
        phrase: String = PARLEY,
        id: String = "s1",
        variants: List<String> = listOf(HEARD),
        source: String = DictionarySync.SOURCE_MANUAL,
        updatedAt: Long = NOW - 5_000,
        deletedAt: Long? = null,
    ) = CloudDictionaryEntry(id, phrase, variants, source, updatedAt = updatedAt, deletedAt = deletedAt)

    private fun state(
        synced: Map<String, DictionarySynced>,
        pendingDeletes: Map<String, Long> = emptyMap(),
        clearedAt: Long? = null,
    ) = DictionarySyncState(userId = USER, synced = synced, pendingDeletes = pendingDeletes, clearedAt = clearedAt)

    private fun fresh() = DictionarySyncState(userId = USER)

    private fun out(lexicon: Lexicon, s: DictionarySyncState) =
        DictionarySync.outgoing(DictionarySync.project(lexicon), s, NOW)

    /** Apply [rows] to [lexicon] from a fresh snapshot, as a first pull would. */
    private fun pulled(rows: List<CloudDictionaryEntry>, lexicon: Lexicon = Lexicon()): Pair<Lexicon, DictionarySyncState> {
        val r = DictionarySync.apply(lexicon, fresh(), out(lexicon, fresh()), DictionarySync.Exchange(rows, emptyList()))
        return (r.lexicon ?: lexicon) to r.state
    }

    private fun guardedSnapshot() =
        (0 until DictionarySync.RESET_GUARD_MIN).associate { "p$it" to DictionarySynced("s$it") }

    // ── projection ───────────────────────────────────────────────────────────

    @Test
    fun `projects terms and confirmed pairs but not guesses`() {
        val lexicon = Lexicon(
            pairs = listOf(
                confirmed(HEARD, PARLEY),
                confirmed(HEARD_2, PARLEY, T0 + 5_000),
                LexiconPair("色瑞", "Cerana", 1, T0),
            ),
            terms = listOf(LexiconTerm(PARLEY, T0), LexiconTerm("Pathors", T0)),
        )
        val p = DictionarySync.project(lexicon)
        assertEquals(setOf(PARLEY, "Pathors"), p.keys)
        assertEquals(listOf(HEARD_2, HEARD).sorted(), p[PARLEY]?.variants)
        assertEquals(DictionarySync.SOURCE_MANUAL, p[PARLEY]?.source)
        assertEquals(NOW - 5_000, p[PARLEY]?.updatedAt)
        assertEquals(emptyList<String>(), p["Pathors"]?.variants)
    }

    @Test
    fun `a pair without a term is learned`() {
        assertEquals(LEARNED, DictionarySync.project(Lexicon(listOf(confirmed(HEARD, PARLEY))))[PARLEY]?.source)
    }

    // ── outgoing ─────────────────────────────────────────────────────────────

    @Test
    fun `first sync offers every phrase`() {
        var n = 0
        val lexicon = Lexicon(listOf(confirmed(HEARD, PARLEY)), listOf(LexiconTerm("Cerana", T0)))
        val o = DictionarySync.outgoing(DictionarySync.project(lexicon), fresh(), NOW) { "new${++n}" }
        assertEquals(
            listOf(
                row("Cerana", id = "new1", variants = emptyList(), updatedAt = T0),
                row(PARLEY, id = "new2", source = LEARNED, updatedAt = T0),
            ),
            o.entries,
        )
        assertFalse(o.reset)
    }

    @Test
    fun `skips what matches the snapshot and offers what changed`() {
        val lexicon = Lexicon(
            listOf(confirmed(HEARD, PARLEY), confirmed("色瑞", "Cerana")),
            listOf(LexiconTerm(PARLEY, T0)),
        )
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD)), "Cerana" to DictionarySynced("s2")))
        assertEquals(
            listOf(row("Cerana", id = "s2", variants = listOf("色瑞"), source = LEARNED, updatedAt = T0)),
            out(lexicon, s).entries,
        )
    }

    @Test
    fun `a phrase gone from the lexicon is a tombstone keeping its first seen time`() {
        val synced = mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD)))
        val s = state(synced, pendingDeletes = mapOf(PARLEY to NOW - 60_000))
        val o = DictionarySync.outgoing(emptyMap(), s, NOW)
        assertEquals(listOf(row(variants = emptyList(), updatedAt = NOW - 60_000, deletedAt = NOW - 60_000)), o.entries)
        assertEquals(mapOf(PARLEY to NOW - 60_000), o.pendingDeletes)
        assertEquals(mapOf(PARLEY to NOW), DictionarySync.outgoing(emptyMap(), state(synced), NOW).pendingDeletes)
    }

    @Test
    fun `removing one correction sends the entry without it`() {
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD_2, HEARD))))
        val o = out(Lexicon(listOf(confirmed(HEARD, PARLEY))), s)
        assertEquals(listOf(listOf(HEARD)), o.entries.map { it.variants })
        assertEquals(listOf("s1"), o.entries.map { it.id })
    }

    @Test
    fun `variants the phone cannot hold are neither deleted nor diffed`() {
        // 派 → 派對 is a single CJK character: the desktop can keep it, the phone cannot.
        val s = state(mapOf(PARTY to DictionarySynced("s1", listOf(LONE, QUEUE), held = listOf(QUEUE))))
        assertTrue(out(Lexicon(listOf(confirmed(QUEUE, PARTY))), s).entries.isEmpty())
    }

    // ── the phone only removes what it held ─────────────────────────────────

    @Test
    fun `a phrase with more variants than the phone holds keeps them all through an edit`() {
        val all = (0 until Lexicon.MAX_PAIRS + 100).map { "v$it" }
        val (lex, s) = pulled(listOf(row(variants = all, source = LEARNED)))
        assertEquals(Lexicon.MAX_PAIRS, lex.pairs.size)
        assertEquals(Lexicon.MAX_PAIRS, s.synced.getValue(PARLEY).held.toSet().size)
        assertEquals(all, s.synced.getValue(PARLEY).variants)
        assertTrue("holding only part of it is not a change", out(lex, s).entries.isEmpty())

        val removed = lex.pairs[0].original
        val edited = lex.copy(pairs = lex.pairs.drop(1) + confirmed("mine", PARLEY))
        val o = out(edited, s)
        assertEquals(1, o.entries.size)
        assertEquals(all.toSet() - removed + "mine", o.entries[0].variants.toSet())
        assertEquals("s1", o.entries[0].id)
    }

    @Test
    fun `a phrase beyond the term cap is never tombstoned`() {
        val rows = (0..Lexicon.MAX_TERMS).map { row("t$it", id = "s$it", variants = emptyList(), updatedAt = T0 + it) }
        val (lex, s) = pulled(rows)
        assertEquals(Lexicon.MAX_TERMS, lex.terms.size)
        assertEquals(setOf("t0"), s.synced.keys - lex.terms.map { it.text }.toSet())
        assertEquals(false, s.synced["t0"]?.heldPhrase)
        assertTrue(out(lex, s).entries.isEmpty())

        val o = out(lex.removeTerm("t5"), s)
        assertEquals(listOf("t5"), o.entries.map { it.phrase })
        assertNotNull(o.entries[0].deletedAt)
    }

    @Test
    fun `a refused single character variant survives phone edits`() {
        val answered = row(PARTY, variants = listOf(LONE), source = LEARNED, updatedAt = NOW)
        val (lex, s) = pulled(listOf(row(PARTY, variants = listOf(LONE, QUEUE), source = LEARNED)))
        assertEquals(listOf(QUEUE), lex.pairs.map { it.original })
        assertEquals(listOf(QUEUE), s.synced[PARTY]?.held)

        val added = lex.copy(pairs = lex.pairs + confirmed("拍對", PARTY))
        assertEquals(listOf(listOf("拍對", QUEUE, LONE)), out(added, s).entries.map { it.variants })

        // Removing everything the phone held does not delete what it never held.
        val removed = lex.copy(pairs = emptyList())
        val o = out(removed, s)
        assertEquals(1, o.entries.size)
        assertNull(o.entries[0].deletedAt)
        assertEquals(listOf(LONE), o.entries[0].variants)
        assertEquals(setOf(PARTY), o.released)
        val after = DictionarySync.apply(removed, s, o, DictionarySync.Exchange(emptyList(), listOf(answered)))
        assertNull("a released phrase is not written back", after.lexicon)
        assertEquals(false, after.state.synced[PARTY]?.heldPhrase)

        val next = DictionarySync.outgoing(emptyMap(), after.state, NOW)
        assertTrue(next.entries.isEmpty())
        val echo = DictionarySync.apply(removed, after.state, next, DictionarySync.Exchange(listOf(answered), emptyList()))
        assertNull(echo.lexicon)
    }

    @Test
    fun `a phrase held whole is tombstoned when removed`() {
        val (lex, s) = pulled(listOf(row(source = LEARNED)))
        assertEquals(1, lex.pairs.size)
        val o = DictionarySync.outgoing(emptyMap(), s, NOW)
        assertEquals(listOf<Long?>(NOW), o.entries.map { it.deletedAt })
        assertTrue(o.released.isEmpty())
    }

    @Test
    fun `does not offer a form the cloud refused for good`() {
        val projection = DictionarySync.project(Lexicon(terms = listOf(LexiconTerm("x".repeat(150), T0))))
        val s = fresh().copy(parked = projection.mapValues { DictionarySync.fingerprint(it.value) })
        assertTrue(DictionarySync.outgoing(projection, s, NOW).entries.isEmpty())
    }

    @Test
    fun `a suddenly empty dictionary is a lost file, not a mass deletion`() {
        val o = DictionarySync.outgoing(emptyMap(), state(guardedSnapshot()), NOW)
        assertTrue(o.reset)
        assertTrue(o.entries.isEmpty())
        val few = DictionarySync.outgoing(emptyMap(), state(mapOf("a" to DictionarySynced("s"))), NOW)
        assertEquals(1, few.entries.size)
    }

    @Test
    fun `an explicit clear gets through the guard`() {
        val o = DictionarySync.outgoing(emptyMap(), state(guardedSnapshot(), clearedAt = NOW - 1_000), NOW)
        assertFalse(o.reset)
        assertEquals(DictionarySync.RESET_GUARD_MIN, o.entries.size)
        assertEquals(setOf(NOW - 1_000), o.entries.mapNotNull { it.deletedAt }.toSet())
    }

    // ── apply ────────────────────────────────────────────────────────────────

    @Test
    fun `applies other devices rows to untouched phrases`() {
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD)), "Gone" to DictionarySynced("s2")))
        val lexicon = Lexicon(
            listOf(confirmed(HEARD, PARLEY)),
            listOf(LexiconTerm(PARLEY, T0), LexiconTerm("Gone", T0)),
        )
        val result = DictionarySync.apply(
            lexicon,
            s,
            out(lexicon, s),
            DictionarySync.Exchange(
                pulled = listOf(
                    row(variants = listOf(HEARD, HEARD_2), updatedAt = NOW - 1),
                    row("Gone", id = "s2", variants = emptyList(), deletedAt = NOW - 1),
                    row("Cerana", id = "s3", variants = emptyList(), updatedAt = NOW - 2),
                    row("Pathors", id = "s4", variants = listOf("怕ddors"), source = LEARNED, updatedAt = NOW - 3),
                ),
                pushed = emptyList(),
            ),
        )
        val lex = result.lexicon!!
        assertEquals(setOf(PARLEY, "Cerana"), lex.terms.map { it.text }.toSet())
        assertEquals(
            setOf("$HEARD→$PARLEY×$threshold", "$HEARD_2→$PARLEY×$threshold", "怕ddors→Pathors×$threshold"),
            lex.pairs.map { "${it.original}→${it.replacement}×${it.count}" }.toSet(),
        )
        assertEquals(DictionarySynced("s1", listOf(HEARD, HEARD_2), held = listOf(HEARD_2, HEARD)), result.state.synced[PARLEY])
        assertEquals(DictionarySynced("s3"), result.state.synced["Cerana"])
        assertNull(result.state.synced["Gone"])
        assertTrue("applying leaves nothing to send back", out(lex, result.state).entries.isEmpty())
    }

    @Test
    fun `never lets a pulled row overwrite a local edit`() {
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD))))
        val sent = Lexicon(listOf(confirmed(HEARD, PARLEY), confirmed(HEARD_2, PARLEY)))
        val o = out(sent, s)
        val edited = Lexicon(sent.pairs + confirmed("趴理", PARLEY))
        val result = DictionarySync.apply(
            edited,
            s,
            o,
            DictionarySync.Exchange(listOf(row(variants = listOf("theirs"))), listOf(row(variants = listOf(HEARD, HEARD_2)))),
        )
        assertNull(result.lexicon)
        assertEquals(listOf(HEARD), result.state.synced[PARLEY]?.variants)
    }

    @Test
    fun `adopts the pushed merge including the cloud's id`() {
        val lexicon = Lexicon(listOf(confirmed(HEARD, PARLEY)))
        val o = DictionarySync.outgoing(DictionarySync.project(lexicon), fresh(), NOW) { "mine" }
        val result = DictionarySync.apply(
            lexicon,
            fresh(),
            o,
            DictionarySync.Exchange(
                listOf(row(id = "desk", variants = listOf(HEARD_2))),
                listOf(row(id = "desk", variants = listOf(HEARD_2, HEARD), source = LEARNED)),
            ),
        )
        assertEquals(setOf(HEARD_2, HEARD), result.lexicon?.pairs?.map { it.original }?.toSet())
        assertEquals("desk", result.state.synced[PARLEY]?.id)
    }

    @Test
    fun `confirms a deletion, and brings the entry back when a newer edit won`() {
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD))))
        val o = DictionarySync.outgoing(emptyMap(), s, NOW)
        val gone = DictionarySync.apply(
            Lexicon(), s, o,
            DictionarySync.Exchange(emptyList(), listOf(row(variants = emptyList(), deletedAt = NOW))),
        )
        assertNull(gone.lexicon)
        assertTrue(gone.state.synced.isEmpty())
        assertTrue(gone.state.pendingDeletes.isEmpty())

        val lost = DictionarySync.apply(
            Lexicon(), s, o,
            DictionarySync.Exchange(emptyList(), listOf(row(variants = listOf("newer"), updatedAt = NOW + 1))),
        )
        assertEquals(listOf("newer"), lost.lexicon?.pairs?.map { it.original })
        assertEquals(listOf(PARLEY), lost.lexicon?.terms?.map { it.text })
    }

    @Test
    fun `a tombstone removes the term and its confirmed pairs but not guesses`() {
        val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD))))
        val guess = LexiconPair("趴理", PARLEY, 1, T0)
        val lexicon = Lexicon(listOf(confirmed(HEARD, PARLEY), guess), listOf(LexiconTerm(PARLEY, T0)))
        val result = DictionarySync.apply(
            lexicon, s, out(lexicon, s),
            DictionarySync.Exchange(listOf(row(variants = emptyList(), deletedAt = NOW)), emptyList()),
        )
        assertEquals(listOf(guess), result.lexicon?.pairs)
        assertEquals(emptyList<LexiconTerm>(), result.lexicon?.terms)
    }

    @Test
    fun `a row with nothing the phone can hold becomes a term`() {
        val result = DictionarySync.apply(
            Lexicon(), fresh(), DictionarySync.outgoing(emptyMap(), fresh(), NOW),
            DictionarySync.Exchange(listOf(row(PARTY, variants = listOf(LONE), source = LEARNED)), emptyList()),
        )
        assertEquals(listOf(PARTY), result.lexicon?.terms?.map { it.text })
        assertEquals(emptyList<LexiconPair>(), result.lexicon?.pairs)
        assertEquals(DictionarySynced("s1", listOf(LONE), held = emptyList(), source = LEARNED), result.state.synced[PARTY])
        assertTrue(out(result.lexicon!!, result.state).entries.isEmpty())
    }

    @Test
    fun `parks a permanent refusal but retries a transient one`() {
        val lexicon = Lexicon(terms = listOf(LexiconTerm("Long", T0), LexiconTerm("Full", T0)))
        val result = DictionarySync.apply(
            lexicon, fresh(), out(lexicon, fresh()),
            DictionarySync.Exchange(
                emptyList(),
                emptyList(),
                listOf(DictionarySync.Rejection("Long", "phrase_too_long"), DictionarySync.Rejection("Full", "entry_limit")),
            ),
        )
        assertEquals(setOf("Long"), result.state.parked.keys)
        assertEquals(listOf("Full"), out(lexicon, result.state).entries.map { it.phrase })
    }

    @Test
    fun `the cloud's mapping wins for a misheard form the phone mapped elsewhere`() {
        val lexicon = Lexicon(listOf(LexiconPair(HEARD, "Pali", 1, T0)))
        val result = DictionarySync.apply(
            lexicon, fresh(), DictionarySync.outgoing(emptyMap(), fresh(), NOW),
            DictionarySync.Exchange(listOf(row()), emptyList()),
        )
        assertEquals(listOf(PARLEY), result.lexicon?.pairs?.map { it.replacement })
    }

    // ── wire ─────────────────────────────────────────────────────────────────

    private val wire = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    @Test
    fun `decodes the server's shapes and encodes a deletion`() {
        val pull = wire.decodeFromString(
            DictionaryPullResponse.serializer(),
            """{"entries":[{"id":"a","phrase":"P","variants":["p"],"source":"learned","confirmed":true,"updatedAt":$NOW,"deletedAt":null}],"now":${NOW + 1}}""",
        )
        assertEquals(listOf(row("P", id = "a", variants = listOf("p"), source = LEARNED, updatedAt = NOW)), pull.entries)
        assertEquals(NOW + 1, pull.now)
        val push = wire.decodeFromString(
            DictionaryPushResponse.serializer(),
            """{"entries":[],"rejected":[{"index":2,"id":"x","error":"phrase_too_long"}],"now":1}""",
        )
        assertEquals(listOf(CloudDictionaryRejection(2, "x", "phrase_too_long")), push.rejected)

        val sent = wire.encodeToJsonElement(
            ListSerializer(CloudDictionaryEntry.serializer()),
            listOf(row(deletedAt = NOW), row()),
        ) as JsonArray
        assertEquals(NOW, (sent[0] as JsonObject)["deletedAt"]!!.jsonPrimitive.long)
        assertEquals("true", (sent[0] as JsonObject)["confirmed"]!!.jsonPrimitive.content)
        assertFalse("a live entry leaves deletedAt out", (sent[1] as JsonObject).containsKey("deletedAt"))
    }

    // ── run ──────────────────────────────────────────────────────────────────

    @Test
    fun `run pulls, pushes, writes the merge, and pages from the cursor`() = runBlocking {
        val storage = MemoryStorage(Lexicon(listOf(confirmed(HEARD, PARLEY))))
        val cloud = FakeCloud(
            pull = { DictionaryPullResponse(listOf(row("Cerana", id = "s9", variants = emptyList())), NOW) },
            push = { entries -> DictionaryPushResponse(entries.map { it.copy(id = "srv") }) },
        )
        val outcome = DictionarySync.run(USER, cloud, storage) { NOW }
        assertEquals(DictionarySync.Outcome.Synced(pulled = 1, pushed = 1, refused = 0), outcome)
        assertEquals(listOf("pull:null", "push:$PARLEY"), cloud.calls)
        assertEquals(setOf("Cerana"), storage.lexicon.terms.map { it.text }.toSet())
        assertEquals(NOW, storage.state?.cursor)
        assertEquals("srv", storage.state?.synced?.get(PARLEY)?.id)
        assertEquals(NOW, storage.state?.lastSyncedAt)
        assertEquals(false, storage.state?.lastFailed)

        cloud.calls.clear()
        cloud.pull = { DictionaryPullResponse(emptyList(), NOW + 5) }
        DictionarySync.run(USER, cloud, storage)
        assertEquals("nothing changed here: only a pull, from the cursor", listOf("pull:$NOW"), cloud.calls)
        assertFalse(DictionarySync.hasLocalChanges(storage, USER))
    }

    @Test
    fun `a failed run changes nothing and keeps the cursor`() = runBlocking {
        val lexicon = Lexicon(terms = listOf(LexiconTerm(PARLEY, T0)))
        val storage = MemoryStorage(lexicon)
        val outcome = DictionarySync.run(USER, FakeCloud(), storage)
        assertTrue("$outcome", outcome is DictionarySync.Outcome.Failed)
        assertEquals(lexicon, storage.lexicon)
        assertEquals(0, storage.lexiconWrites)
        assertNull(storage.state?.cursor)
        assertEquals(true, storage.state?.lastFailed)
        assertTrue(DictionarySync.hasLocalChanges(storage, USER))
    }

    @Test
    fun `another account starts over instead of deleting its entries`() = runBlocking {
        val old = DictionarySyncState(userId = "someone-else", cursor = NOW, synced = mapOf("Old" to DictionarySynced("o")))
        val storage = MemoryStorage(Lexicon(), old)
        val cloud = FakeCloud(pull = { DictionaryPullResponse(emptyList(), NOW) })
        DictionarySync.run(USER, cloud, storage)
        assertEquals("a full pull, and no tombstone for Old", listOf("pull:null"), cloud.calls)
        assertEquals(USER, storage.state?.userId)
    }

    @Test
    fun `a clear is carried out once, then forgotten`() = runBlocking {
        val s = DictionarySyncState(userId = USER, cursor = NOW, synced = guardedSnapshot(), clearedAt = NOW - 1)
        val storage = MemoryStorage(Lexicon(), s)
        val cloud = FakeCloud(
            pull = { DictionaryPullResponse(emptyList(), NOW) },
            push = { DictionaryPushResponse(it) },
        )
        DictionarySync.run(USER, cloud, storage)
        assertTrue(cloud.calls.last().startsWith("push:"))
        assertEquals(emptyMap<String, DictionarySynced>(), storage.state?.synced)
        assertNull(storage.state?.clearedAt)
    }

    @Test
    fun `pushes in batches the server accepts`() = runBlocking {
        // Built directly: addTerm would evict past the cap, and batching is under test.
        val terms = (0 until DictionarySync.PUSH_BATCH + 3).map { LexiconTerm("t$it", T0) }
        val cloud = FakeCloud(
            pull = { DictionaryPullResponse(emptyList(), NOW) },
            push = { DictionaryPushResponse(it) },
        )
        DictionarySync.run(USER, cloud, MemoryStorage(Lexicon(terms = terms)))
        assertEquals(listOf(DictionarySync.PUSH_BATCH, 3), cloud.pushSizes)
    }

    @Test
    fun `the file storage round-trips the snapshot and remembers a clear`() {
        val dir = kotlin.io.path.createTempDirectory("dict-sync").toFile()
        try {
            val store = LexiconStore(java.io.File(dir, LexiconStore.FILE_NAME))
            val storage = FileDictionarySyncStorage(store, java.io.File(dir, FileDictionarySyncStorage.FILE_NAME))
            assertNull(storage.loadState())
            val s = state(mapOf(PARLEY to DictionarySynced("s1", listOf(HEARD))), pendingDeletes = mapOf("x" to 1L))
            storage.saveState(s)
            assertEquals(s, storage.loadState())
            storage.noteCleared(NOW)
            assertEquals(NOW, storage.loadState()?.clearedAt)
            assertEquals(s.synced, storage.loadState()?.synced)
        } finally {
            dir.deleteRecursively()
        }
    }
}

private class MemoryStorage(
    var lexicon: Lexicon,
    var state: DictionarySyncState? = null,
) : DictionarySyncStorage {
    var lexiconWrites = 0

    override fun loadLexicon(): Lexicon = lexicon
    override fun saveLexicon(lexicon: Lexicon) {
        this.lexicon = lexicon
        lexiconWrites++
    }
    override fun loadState(): DictionarySyncState? = state
    override fun saveState(state: DictionarySyncState) {
        this.state = state
    }
}

private class FakeCloud(
    var pull: () -> DictionaryPullResponse = { throw IOException("offline") },
    var push: (List<CloudDictionaryEntry>) -> DictionaryPushResponse = { throw IOException("offline") },
) : DictionarySyncTransport {
    val calls = mutableListOf<String>()
    val pushSizes = mutableListOf<Int>()

    override suspend fun pullDictionary(since: Long?): DictionaryPullResponse {
        calls += "pull:$since"
        return pull()
    }

    override suspend fun pushDictionary(entries: List<CloudDictionaryEntry>): DictionaryPushResponse {
        calls += "push:" + entries.joinToString(",") { it.phrase }
        pushSizes += entries.size
        return push(entries)
    }
}
