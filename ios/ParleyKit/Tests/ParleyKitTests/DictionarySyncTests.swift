import XCTest

@testable import ParleyKit

/// Personal-dictionary sync: the projection, the diff, the merge back into the
/// lexicon, and a full run against a fake cloud. Mirrors the desktop's
/// `src/lib/cloud/dictionarySync.test.ts` case for case where the two share a
/// rule, plus what only the phone has (unconfirmed pairs, variants it cannot
/// hold, the explicit clear).
final class DictionarySyncTests: XCTestCase {
    private let now: Int64 = 1_790_000_000_000
    private var t0: Date { DictionarySync.date(now - 10_000) }
    private let threshold = Lexicon.autoApplyThreshold

    private func confirmed(_ original: String, _ replacement: String, at: Date? = nil) -> LexiconPair {
        LexiconPair(
            original: original, replacement: replacement, count: threshold, updatedAt: at ?? t0)
    }

    private func row(
        _ phrase: String = "Parley", id: String = "s1", variants: [String] = ["怕理"],
        source: String = "manual", updatedAt: Int64? = nil, deletedAt: Int64? = nil
    ) -> CloudDictionaryEntry {
        CloudDictionaryEntry(
            id: id, phrase: phrase, variants: variants, source: source,
            updatedAt: updatedAt ?? now - 5_000, deletedAt: deletedAt)
    }

    private func state(
        _ synced: [String: DictionarySyncState.Synced], pendingDeletes: [String: Int64] = [:],
        clearedAt: Int64? = nil
    ) -> DictionarySyncState {
        var s = DictionarySyncState(userId: "u1")
        s.synced = synced
        s.pendingDeletes = pendingDeletes
        s.clearedAt = clearedAt
        return s
    }

    private func ids(_ out: DictionarySync.Outgoing) -> [String] { out.entries.map(\.phrase) }

    // MARK: projection

    func testProjectsTermsAndConfirmedPairsButNotGuesses() {
        let lexicon = Lexicon(
            pairs: [
                confirmed("怕理", "Parley"),
                confirmed("帕力", "Parley", at: t0.addingTimeInterval(5)),
                LexiconPair(original: "色瑞", replacement: "Cerana", count: 1, updatedAt: t0),
            ],
            terms: [LexiconTerm(text: "Parley", updatedAt: t0), LexiconTerm(text: "Pathors", updatedAt: t0)])
        let p = DictionarySync.project(lexicon)
        XCTAssertEqual(Set(p.keys), ["Parley", "Pathors"])
        XCTAssertEqual(p["Parley"]?.variants, ["帕力", "怕理"].sorted())
        XCTAssertEqual(p["Parley"]?.source, "manual")
        XCTAssertEqual(p["Parley"]?.updatedAt, now - 5_000)
        XCTAssertEqual(p["Pathors"]?.variants, [])
    }

    func testAPairWithoutATermIsLearned() {
        let p = DictionarySync.project(Lexicon(pairs: [confirmed("怕理", "Parley")]))
        XCTAssertEqual(p["Parley"]?.source, "learned")
    }

    // MARK: outgoing

    func testFirstSyncOffersEveryPhrase() {
        var n = 0
        let lexicon = Lexicon(
            pairs: [confirmed("怕理", "Parley")], terms: [LexiconTerm(text: "Cerana", updatedAt: t0)])
        let out = DictionarySync.outgoing(
            DictionarySync.project(lexicon), state: DictionarySyncState(userId: "u1"), now: now,
            newId: { n += 1; return "new\(n)" })
        XCTAssertEqual(
            out.entries,
            [
                row("Cerana", id: "new1", variants: [], updatedAt: now - 10_000),
                row("Parley", id: "new2", variants: ["怕理"], source: "learned", updatedAt: now - 10_000),
            ])
        XCTAssertFalse(out.reset)
    }

    func testSkipsWhatMatchesTheSnapshotAndOffersWhatChanged() {
        let lexicon = Lexicon(
            pairs: [confirmed("怕理", "Parley"), confirmed("色瑞", "Cerana")],
            terms: [LexiconTerm(text: "Parley", updatedAt: t0)])
        let s = state([
            "Parley": .init(id: "s1", variants: ["怕理"]),
            "Cerana": .init(id: "s2", variants: []),
        ])
        let out = DictionarySync.outgoing(DictionarySync.project(lexicon), state: s, now: now)
        XCTAssertEqual(
            out.entries,
            [row("Cerana", id: "s2", variants: ["色瑞"], source: "learned", updatedAt: now - 10_000)])
    }

    func testAPhraseGoneFromTheLexiconIsATombstoneKeepingItsFirstSeenTime() {
        let s = state(
            ["Parley": .init(id: "s1", variants: ["怕理"])], pendingDeletes: ["Parley": now - 60_000])
        let out = DictionarySync.outgoing([:], state: s, now: now)
        XCTAssertEqual(
            out.entries, [row(variants: [], updatedAt: now - 60_000, deletedAt: now - 60_000)])
        XCTAssertEqual(out.pendingDeletes, ["Parley": now - 60_000])
        let fresh = DictionarySync.outgoing([:], state: state(s.synced), now: now)
        XCTAssertEqual(fresh.pendingDeletes, ["Parley": now])
    }

    func testRemovingOneCorrectionSendsTheEntryWithoutIt() {
        let s = state(["Parley": .init(id: "s1", variants: ["帕力", "怕理"])])
        let lexicon = Lexicon(pairs: [confirmed("怕理", "Parley")])
        let out = DictionarySync.outgoing(DictionarySync.project(lexicon), state: s, now: now)
        XCTAssertEqual(out.entries.map(\.variants), [["怕理"]])
        XCTAssertEqual(out.entries.map(\.id), ["s1"])
    }

    func testVariantsThePhoneCannotHoldAreNeitherDeletedNorDiffed() {
        // "派" → "派對" is a single CJK character: the desktop can keep it, the
        // phone cannot store it as a correction.
        let s = state(["派對": .init(id: "s1", variants: ["派", "排隊"], held: ["排隊"])])
        let held = Lexicon(pairs: [confirmed("排隊", "派對")])
        XCTAssertTrue(
            DictionarySync.outgoing(DictionarySync.project(held), state: s, now: now).entries.isEmpty)
    }

    // MARK: the phone only removes what it held

    /// Apply `rows` to `lexicon` from a fresh snapshot, as a first pull would.
    private func pulled(_ rows: [CloudDictionaryEntry], into lexicon: Lexicon = Lexicon())
        -> (lexicon: Lexicon, state: DictionarySyncState)
    {
        let start = DictionarySyncState(userId: "u1")
        let r = DictionarySync.apply(
            lexicon, state: start,
            outgoing: DictionarySync.outgoing(DictionarySync.project(lexicon), state: start, now: now),
            exchange: .init(pulled: rows, pushed: []))
        return (r.lexicon ?? lexicon, r.state)
    }

    func testAPhraseWithMoreVariantsThanThePhoneHoldsKeepsThemAllThroughAnEdit() {
        let all = (0..<(Lexicon.maxPairs + 100)).map { "v\($0)" }
        let (lex, s) = pulled([row(variants: all, source: "learned")])
        XCTAssertEqual(lex.pairs.count, Lexicon.maxPairs)
        let held = Set(s.synced["Parley"]!.held)
        XCTAssertEqual(held.count, Lexicon.maxPairs)
        XCTAssertEqual(s.synced["Parley"]!.variants, all)
        // Holding only part of it is not a change.
        XCTAssertTrue(DictionarySync.outgoing(DictionarySync.project(lex), state: s, now: now).entries.isEmpty)

        // The user removes one correction they held and adds one of their own.
        let removed = lex.pairs[0].original
        var edited = lex
        edited.pairs.removeFirst()
        edited.pairs.append(confirmed("mine", "Parley"))
        let out = DictionarySync.outgoing(DictionarySync.project(edited), state: s, now: now)
        XCTAssertEqual(out.entries.count, 1)
        let sent = Set(out.entries[0].variants)
        XCTAssertEqual(sent, Set(all).subtracting([removed]).union(["mine"]))
        XCTAssertEqual(out.entries[0].id, "s1")
    }

    func testAPhraseBeyondTheTermCapIsNeverTombstoned() {
        let rows = (0...Lexicon.maxTerms).map {
            row("t\($0)", id: "s\($0)", variants: [], updatedAt: now - 10_000 + Int64($0))
        }
        let (lex, s) = pulled(rows)
        XCTAssertEqual(lex.terms.count, Lexicon.maxTerms)
        let evicted = Set(s.synced.keys).subtracting(lex.terms.map(\.text))
        XCTAssertEqual(evicted, ["t0"])
        XCTAssertEqual(s.synced["t0"]?.heldPhrase, false)
        XCTAssertTrue(DictionarySync.outgoing(DictionarySync.project(lex), state: s, now: now).entries.isEmpty)

        // Deleting a term the phone did hold sends that, and only that.
        var edited = lex
        edited.terms.removeAll { $0.text == "t5" }
        let out = DictionarySync.outgoing(DictionarySync.project(edited), state: s, now: now)
        XCTAssertEqual(out.entries.map(\.phrase), ["t5"])
        XCTAssertNotNil(out.entries[0].deletedAt)
    }

    func testARefusedSingleCharacterVariantSurvivesPhoneEdits() {
        let (lex, s) = pulled([row("派對", variants: ["派", "排隊"], source: "learned")])
        XCTAssertEqual(lex.pairs.map(\.original), ["排隊"])
        XCTAssertEqual(s.synced["派對"]?.held, ["排隊"])

        // Adding a correction keeps the one the phone cannot hold.
        var added = lex
        added.pairs.append(confirmed("拍對", "派對"))
        let addOut = DictionarySync.outgoing(DictionarySync.project(added), state: s, now: now)
        XCTAssertEqual(addOut.entries.map(\.variants), [["拍對", "排隊", "派"]])

        // Removing everything the phone held does not delete what it never held:
        // the phrase goes up live with just that, and the phone lets go of it.
        var removed = lex
        removed.pairs = []
        let out = DictionarySync.outgoing(DictionarySync.project(removed), state: s, now: now)
        XCTAssertEqual(out.entries.count, 1)
        XCTAssertNil(out.entries[0].deletedAt)
        XCTAssertEqual(out.entries[0].variants, ["派"])
        XCTAssertEqual(out.released, ["派對"])
        let answered = row("派對", variants: ["派"], source: "learned", updatedAt: now)
        let after = DictionarySync.apply(
            removed, state: s, outgoing: out, exchange: .init(pulled: [], pushed: [answered]))
        XCTAssertNil(after.lexicon, "a released phrase is not written back")
        XCTAssertEqual(after.state.synced["派對"]?.heldPhrase, false)
        // Its echo on the next pull does not bring it back either, and nothing
        // is left to send.
        let next = DictionarySync.outgoing([:], state: after.state, now: now)
        XCTAssertTrue(next.entries.isEmpty)
        let echo = DictionarySync.apply(
            removed, state: after.state, outgoing: next, exchange: .init(pulled: [answered], pushed: []))
        XCTAssertNil(echo.lexicon)
    }

    func testAPhraseHeldWholeIsTombstonedWhenRemoved() {
        let (lex, s) = pulled([row(variants: ["怕理"], source: "learned")])
        XCTAssertEqual(lex.pairs.count, 1)
        let out = DictionarySync.outgoing([:], state: s, now: now)
        XCTAssertEqual(out.entries.map(\.deletedAt), [now])
        XCTAssertTrue(out.released.isEmpty)
    }

    func testDoesNotOfferAFormTheCloudRefusedForGood() {
        let lexicon = Lexicon(terms: [LexiconTerm(text: String(repeating: "x", count: 150), updatedAt: t0)])
        var s = DictionarySyncState(userId: "u1")
        let projection = DictionarySync.project(lexicon)
        s.parked = projection.mapValues { DictionarySync.fingerprint($0) }
        XCTAssertTrue(DictionarySync.outgoing(projection, state: s, now: now).entries.isEmpty)
    }

    func testASuddenlyEmptyDictionaryIsALostFileNotAMassDeletion() {
        var synced: [String: DictionarySyncState.Synced] = [:]
        for i in 0..<DictionarySync.resetGuardMin { synced["p\(i)"] = .init(id: "s\(i)", variants: []) }
        let out = DictionarySync.outgoing([:], state: state(synced), now: now)
        XCTAssertTrue(out.reset)
        XCTAssertTrue(out.entries.isEmpty)
        // Below the threshold, emptying it is just emptying it.
        let few = DictionarySync.outgoing([:], state: state(["a": .init(id: "s", variants: [])]), now: now)
        XCTAssertEqual(few.entries.count, 1)
    }

    func testAnExplicitClearGetsThroughTheGuard() {
        var synced: [String: DictionarySyncState.Synced] = [:]
        for i in 0..<DictionarySync.resetGuardMin { synced["p\(i)"] = .init(id: "s\(i)", variants: []) }
        let out = DictionarySync.outgoing([:], state: state(synced, clearedAt: now - 1_000), now: now)
        XCTAssertFalse(out.reset)
        XCTAssertEqual(out.entries.count, DictionarySync.resetGuardMin)
        XCTAssertEqual(Set(out.entries.compactMap(\.deletedAt)), [now - 1_000])
    }

    // MARK: apply

    func testAppliesOtherDevicesRowsToUntouchedPhrases() {
        let s = state([
            "Parley": .init(id: "s1", variants: ["怕理"]),
            "Gone": .init(id: "s2", variants: []),
        ])
        let lexicon = Lexicon(
            pairs: [confirmed("怕理", "Parley")],
            terms: [LexiconTerm(text: "Parley", updatedAt: t0), LexiconTerm(text: "Gone", updatedAt: t0)])
        let out = DictionarySync.outgoing(DictionarySync.project(lexicon), state: s, now: now)
        let result = DictionarySync.apply(
            lexicon, state: s, outgoing: out,
            exchange: .init(
                pulled: [
                    row(variants: ["怕理", "帕力"], updatedAt: now - 1),
                    row("Gone", id: "s2", variants: [], deletedAt: now - 1),
                    row("Cerana", id: "s3", variants: [], updatedAt: now - 2),
                    row("Pathors", id: "s4", variants: ["怕ddors"], source: "learned", updatedAt: now - 3),
                ], pushed: []))
        let lex = try! XCTUnwrap(result.lexicon)
        XCTAssertEqual(Set(lex.terms.map(\.text)), ["Parley", "Cerana"])
        XCTAssertEqual(
            Set(lex.pairs.map { "\($0.original)→\($0.replacement)×\($0.count)" }),
            ["怕理→Parley×\(threshold)", "帕力→Parley×\(threshold)", "怕ddors→Pathors×\(threshold)"])
        XCTAssertEqual(
            result.state.synced["Parley"],
            .init(id: "s1", variants: ["怕理", "帕力"], held: ["帕力", "怕理"]))
        XCTAssertEqual(result.state.synced["Cerana"], .init(id: "s3", variants: []))
        XCTAssertNil(result.state.synced["Gone"])
        // Applying leaves nothing to send back.
        let again = DictionarySync.outgoing(DictionarySync.project(lex), state: result.state, now: now)
        XCTAssertTrue(again.entries.isEmpty)
    }

    func testNeverLetsAPulledRowOverwriteALocalEdit() {
        let s = state(["Parley": .init(id: "s1", variants: ["怕理"])])
        let sent = Lexicon(pairs: [confirmed("怕理", "Parley"), confirmed("帕力", "Parley")])
        let out = DictionarySync.outgoing(DictionarySync.project(sent), state: s, now: now)
        // Edited again during the round trip: neither row applies.
        let edited = Lexicon(pairs: sent.pairs + [confirmed("趴理", "Parley")])
        let result = DictionarySync.apply(
            edited, state: s, outgoing: out,
            exchange: .init(
                pulled: [row(variants: ["theirs"])], pushed: [row(variants: ["怕理", "帕力"])]))
        XCTAssertNil(result.lexicon)
        XCTAssertEqual(result.state.synced["Parley"]?.variants, ["怕理"])
    }

    func testAdoptsThePushedMergeIncludingTheCloudsId() {
        let lexicon = Lexicon(pairs: [confirmed("怕理", "Parley")])
        let out = DictionarySync.outgoing(
            DictionarySync.project(lexicon), state: DictionarySyncState(userId: "u1"), now: now,
            newId: { "mine" })
        let result = DictionarySync.apply(
            lexicon, state: DictionarySyncState(userId: "u1"), outgoing: out,
            exchange: .init(
                pulled: [row(id: "desk", variants: ["帕力"])],
                pushed: [row(id: "desk", variants: ["帕力", "怕理"], source: "learned")]))
        XCTAssertEqual(Set(result.lexicon?.pairs.map(\.original) ?? []), ["帕力", "怕理"])
        XCTAssertEqual(result.state.synced["Parley"]?.id, "desk")
    }

    func testConfirmsADeletionAndBringsTheEntryBackWhenANewerEditWon() {
        let s = state(["Parley": .init(id: "s1", variants: ["怕理"])])
        let out = DictionarySync.outgoing([:], state: s, now: now)
        let confirmedDelete = DictionarySync.apply(
            Lexicon(), state: s, outgoing: out,
            exchange: .init(pulled: [], pushed: [row(variants: [], deletedAt: now)]))
        XCTAssertNil(confirmedDelete.lexicon)
        XCTAssertTrue(confirmedDelete.state.synced.isEmpty)
        XCTAssertTrue(confirmedDelete.state.pendingDeletes.isEmpty)

        let lost = DictionarySync.apply(
            Lexicon(), state: s, outgoing: out,
            exchange: .init(pulled: [], pushed: [row(variants: ["newer"], updatedAt: now + 1)]))
        XCTAssertEqual(lost.lexicon?.pairs.map(\.original), ["newer"])
        XCTAssertEqual(lost.lexicon?.terms.map(\.text), ["Parley"])
    }

    func testATombstoneRemovesTheTermAndItsConfirmedPairsButNotGuesses() {
        let s = state(["Parley": .init(id: "s1", variants: ["怕理"])])
        let guess = LexiconPair(original: "趴理", replacement: "Parley", count: 1, updatedAt: t0)
        let lexicon = Lexicon(
            pairs: [confirmed("怕理", "Parley"), guess], terms: [LexiconTerm(text: "Parley", updatedAt: t0)])
        let out = DictionarySync.outgoing(DictionarySync.project(lexicon), state: s, now: now)
        let result = DictionarySync.apply(
            lexicon, state: s, outgoing: out,
            exchange: .init(pulled: [row(variants: [], deletedAt: now)], pushed: []))
        XCTAssertEqual(result.lexicon?.pairs, [guess])
        XCTAssertEqual(result.lexicon?.terms, [])
    }

    func testARowWithNothingThePhoneCanHoldBecomesATerm() {
        let result = DictionarySync.apply(
            Lexicon(), state: DictionarySyncState(userId: "u1"),
            outgoing: DictionarySync.outgoing([:], state: DictionarySyncState(userId: "u1"), now: now),
            exchange: .init(pulled: [row("派對", variants: ["派"], source: "learned")], pushed: []))
        XCTAssertEqual(result.lexicon?.terms.map(\.text), ["派對"])
        XCTAssertEqual(result.lexicon?.pairs, [])
        XCTAssertEqual(
            result.state.synced["派對"], .init(id: "s1", variants: ["派"], held: [], source: "learned"))
        let again = DictionarySync.outgoing(
            DictionarySync.project(result.lexicon!), state: result.state, now: now)
        XCTAssertTrue(again.entries.isEmpty)
    }

    func testParksAPermanentRefusalButRetriesATransientOne() {
        let lexicon = Lexicon(
            terms: [LexiconTerm(text: "Long", updatedAt: t0), LexiconTerm(text: "Full", updatedAt: t0)])
        let start = DictionarySyncState(userId: "u1")
        let out = DictionarySync.outgoing(DictionarySync.project(lexicon), state: start, now: now)
        let result = DictionarySync.apply(
            lexicon, state: start, outgoing: out,
            exchange: .init(
                pulled: [], pushed: [],
                rejected: [("Long", "phrase_too_long"), ("Full", "entry_limit")]))
        XCTAssertEqual(Array(result.state.parked.keys), ["Long"])
        XCTAssertEqual(
            ids(DictionarySync.outgoing(DictionarySync.project(lexicon), state: result.state, now: now)),
            ["Full"])
    }

    func testTheCloudsMappingWinsForAMisheardFormThePhoneMappedElsewhere() {
        let lexicon = Lexicon(pairs: [LexiconPair(original: "怕理", replacement: "Pali", count: 1, updatedAt: t0)])
        let result = DictionarySync.apply(
            lexicon, state: DictionarySyncState(userId: "u1"),
            outgoing: DictionarySync.outgoing([:], state: DictionarySyncState(userId: "u1"), now: now),
            exchange: .init(pulled: [row()], pushed: []))
        XCTAssertEqual(result.lexicon?.pairs.map(\.replacement), ["Parley"])
    }

    // MARK: wire

    func testDecodesTheServersShapes() throws {
        let pull = try JSONDecoder().decode(
            DictionaryPullResponse.self,
            from: Data(
                #"{"entries":[{"id":"a","phrase":"P","variants":["p"],"source":"learned","confirmed":true,"updatedAt":1790000000000,"deletedAt":null}],"now":1790000000001}"#
                    .utf8))
        XCTAssertEqual(pull.entries, [row("P", id: "a", variants: ["p"], source: "learned", updatedAt: now)])
        XCTAssertEqual(pull.now, now + 1)
        let push = try JSONDecoder().decode(
            DictionaryPushResponse.self,
            from: Data(#"{"entries":[],"rejected":[{"index":2,"id":"x","error":"phrase_too_long"}],"now":1}"#.utf8))
        XCTAssertEqual(push.rejected, [CloudDictionaryRejection(index: 2, id: "x", error: "phrase_too_long")])
        let sent = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(row(deletedAt: now))) as? [String: Any]
        XCTAssertEqual(sent?["deletedAt"] as? Int64, now)
        XCTAssertEqual(sent?["confirmed"] as? Bool, true)
    }

    // MARK: run

    func testRunPullsPushesWritesTheMergeAndPagesFromTheCursor() async {
        let storage = MemoryStorage(
            lexicon: Lexicon(pairs: [confirmed("怕理", "Parley")]))
        let cloud = FakeCloud()
        cloud.respond = { call in
            switch call {
            case .pull: return .pull(.init(entries: [self.row("Cerana", id: "s9", variants: [])], now: self.now))
            case .push(let entries):
                return .push(.init(entries: entries.map { var e = $0; e.id = "srv"; return e }))
            }
        }
        let outcome = await DictionarySync.run(
            userId: "u1", transport: cloud, storage: storage, now: { DictionarySync.date(self.now) })
        XCTAssertEqual(outcome, .synced(pulled: 1, pushed: 1, refused: 0))
        XCTAssertEqual(cloud.calls.map(\.label), ["pull:nil", "push:Parley"])
        XCTAssertEqual(Set(storage.lexicon.terms.map(\.text)), ["Cerana"])
        XCTAssertEqual(storage.state?.cursor, now)
        XCTAssertEqual(storage.state?.synced["Parley"]?.id, "srv")
        XCTAssertEqual(storage.state?.lastSyncedAt, now)
        XCTAssertEqual(storage.state?.lastFailed, false)

        // Nothing changed here: the next run only pulls, from the saved cursor.
        cloud.calls = []
        cloud.respond = { _ in .pull(.init(entries: [], now: self.now + 5)) }
        _ = await DictionarySync.run(userId: "u1", transport: cloud, storage: storage)
        XCTAssertEqual(cloud.calls.map(\.label), ["pull:\(now)"])
        XCTAssertFalse(DictionarySync.hasLocalChanges(storage: storage, userId: "u1"))
    }

    func testAFailedRunChangesNothingAndKeepsTheCursor() async {
        let lexicon = Lexicon(terms: [LexiconTerm(text: "Parley", updatedAt: t0)])
        let storage = MemoryStorage(lexicon: lexicon)
        let cloud = FakeCloud()
        cloud.respond = { _ in throw URLError(.notConnectedToInternet) }
        let outcome = await DictionarySync.run(userId: "u1", transport: cloud, storage: storage)
        guard case .failed = outcome else { return XCTFail("expected failure, got \(outcome)") }
        XCTAssertEqual(storage.lexicon, lexicon)
        XCTAssertEqual(storage.lexiconWrites, 0)
        XCTAssertNil(storage.state?.cursor)
        XCTAssertEqual(storage.state?.lastFailed, true)
        XCTAssertTrue(DictionarySync.hasLocalChanges(storage: storage, userId: "u1"))
    }

    func testAnotherAccountStartsOverInsteadOfDeletingItsEntries() async {
        var old = DictionarySyncState(userId: "someone-else")
        old.cursor = now
        old.synced = ["Old": .init(id: "o", variants: [])]
        let storage = MemoryStorage(lexicon: Lexicon(), state: old)
        let cloud = FakeCloud()
        cloud.respond = { _ in .pull(.init(entries: [], now: self.now)) }
        _ = await DictionarySync.run(userId: "u1", transport: cloud, storage: storage)
        // A full pull, and no tombstone for "Old".
        XCTAssertEqual(cloud.calls.map(\.label), ["pull:nil"])
        XCTAssertEqual(storage.state?.userId, "u1")
    }

    func testAClearIsCarriedOutOnceThenForgotten() async {
        var s = DictionarySyncState(userId: "u1")
        s.cursor = now
        for i in 0..<DictionarySync.resetGuardMin { s.synced["p\(i)"] = .init(id: "s\(i)", variants: []) }
        s.clearedAt = now - 1
        let storage = MemoryStorage(lexicon: Lexicon(), state: s)
        let cloud = FakeCloud()
        cloud.respond = { call in
            switch call {
            case .pull: return .pull(.init(entries: [], now: self.now))
            case .push(let entries): return .push(.init(entries: entries))
            }
        }
        _ = await DictionarySync.run(userId: "u1", transport: cloud, storage: storage)
        XCTAssertEqual(cloud.calls.last?.label.hasPrefix("push:"), true)
        XCTAssertEqual(storage.state?.synced, [:])
        XCTAssertNil(storage.state?.clearedAt)
    }

    func testPushesInBatchesTheServerAccepts() async {
        let terms = (0..<(DictionarySync.pushBatch + 3)).map {
            LexiconTerm(text: "t\($0)", updatedAt: t0)
        }
        // Built directly: `addTerm` would evict past the cap, and the batching
        // is what is under test here.
        let storage = MemoryStorage(lexicon: Lexicon(terms: terms))
        let cloud = FakeCloud()
        cloud.respond = { call in
            switch call {
            case .pull: return .pull(.init(entries: [], now: self.now))
            case .push(let entries): return .push(.init(entries: entries))
            }
        }
        _ = await DictionarySync.run(userId: "u1", transport: cloud, storage: storage)
        XCTAssertEqual(cloud.pushSizes, [DictionarySync.pushBatch, 3])
    }
}

// MARK: fakes

private final class MemoryStorage: DictionarySyncStorage {
    var lexicon: Lexicon
    var state: DictionarySyncState?
    var lexiconWrites = 0

    init(lexicon: Lexicon, state: DictionarySyncState? = nil) {
        self.lexicon = lexicon
        self.state = state
    }

    func loadLexicon() -> Lexicon { lexicon }
    func saveLexicon(_ lexicon: Lexicon) {
        self.lexicon = lexicon
        lexiconWrites += 1
    }
    func loadState() -> DictionarySyncState? { state }
    func saveState(_ state: DictionarySyncState) { self.state = state }
}

private final class FakeCloud: DictionarySyncTransport, @unchecked Sendable {
    enum Call {
        case pull(Int64?)
        case push([CloudDictionaryEntry])

        var label: String {
            switch self {
            case .pull(let since): return "pull:\(since.map(String.init) ?? "nil")"
            case .push(let entries): return "push:" + entries.map(\.phrase).joined(separator: ",")
            }
        }
    }

    enum Reply {
        case pull(DictionaryPullResponse)
        case push(DictionaryPushResponse)
    }

    var calls: [Call] = []
    var respond: (Call) throws -> Reply = { _ in throw URLError(.badServerResponse) }
    var pushSizes: [Int] {
        calls.compactMap { if case .push(let e) = $0 { return e.count } else { return nil } }
    }

    func pullDictionary(since: Int64?) async throws -> DictionaryPullResponse {
        let call = Call.pull(since)
        calls.append(call)
        guard case .pull(let r) = try respond(call) else { throw URLError(.badServerResponse) }
        return r
    }

    func pushDictionary(_ entries: [CloudDictionaryEntry]) async throws -> DictionaryPushResponse {
        let call = Call.push(entries)
        calls.append(call)
        guard case .push(let r) = try respond(call) else { throw URLError(.badServerResponse) }
        return r
    }
}
