import Foundation
import XCTest

@testable import ParleyKit

final class MicIntroTests: XCTestCase {

    private func seg(_ id: String, _ text: String, final: Bool = true) -> TranscriptSegment {
        TranscriptSegment(id: id, source: "mix", speaker: 0, text: text, isFinal: final, startMs: 0, endMs: 0)
    }

    // MARK: transcript

    func testRunsJoinInIdOrderThenTheTail() {
        var t = MicIntro.Transcript()
        t.accept(seg("mix-1", "我主要用 Parley"))
        t.accept(seg("mix-0", "我是派斯科技的設計師，"))
        t.accept(seg("mix-tail", "來整理", final: false))
        XCTAssertEqual(t.text, "我是派斯科技的設計師，我主要用 Parley來整理")
    }

    func testASettledRunClearsTheTailSoItIsNotSaidTwice() {
        var t = MicIntro.Transcript()
        t.accept(seg("mix-0", "我是"))
        t.accept(seg("mix-tail", "王小明", final: false))
        t.accept(seg("mix-0", "我是王小明"))
        XCTAssertEqual(t.text, "我是王小明")
    }

    func testAGrowingRunReplacesItself() {
        var t = MicIntro.Transcript()
        t.accept(seg("mix-0", "I'm"))
        t.accept(seg("mix-0", "I'm Ming"))
        t.accept(seg("mix-1", "at Pathors"))
        XCTAssertEqual(t.text, "I'm Ming at Pathors")
    }

    func testRunsJoinWithASpaceOnlyBetweenLatin() {
        XCTAssertEqual(MicIntro.joinRuns(["Hello", "world"]), "Hello world")
        XCTAssertEqual(MicIntro.joinRuns(["我是", "王小明"]), "我是王小明")
        XCTAssertEqual(MicIntro.joinRuns(["Parley", "很好用"]), "Parley很好用")
        XCTAssertEqual(MicIntro.joinRuns(["  ", "a", ""]), "a")
    }

    // MARK: normalizing

    func testTheProductNameIsFixedAndSpacedFromChinese() {
        XCTAssertEqual(MicIntro.fixProductName("我主要用帕雷來整理"), "我主要用 Parley 來整理")
        XCTAssertEqual(MicIntro.fixProductName("I use PARLAY daily"), "I use Parley daily")
        XCTAssertEqual(MicIntro.fixProductName("I use par lay daily"), "I use Parley daily")
        XCTAssertEqual(MicIntro.fixProductName("le parlement"), "le parlement", "whole words only")
        XCTAssertEqual(MicIntro.fixProductName("用 Parley 來"), "用 Parley 來", "already right stays right")
    }

    func testNormalizeConvertsToTraditionalAndAppliesReplacements() {
        let out = MicIntro.normalize("我是设计师，我用帕利开会") { $0.replacingOccurrences(of: "設計師", with: "設計總監") }
        XCTAssertEqual(out, "我是設計總監，我用 Parley 開會")
    }

    // MARK: the script

    func testTheScriptGivesCompanyAndName() {
        let zh = MicIntro.parseScript("我是派斯科技的設計師王小明，我主要用 Parley 來整理客戶會議。")
        XCTAssertEqual(zh.company, "派斯科技")
        XCTAssertEqual(zh.name, "", "設計師王小明 is one word with a title in it")
        let zhName = MicIntro.parseScript("我是派斯科技的王小明，我主要用 Parley")
        XCTAssertEqual(zhName.name, "王小明")
        let title = MicIntro.parseScript("我是派斯科技的設計師，我主要用 Parley")
        XCTAssertEqual(title.name, "", "a title is not a name")
        let en = MicIntro.parseScript("I'm Ming, a designer at Pathors, and I use Parley")
        XCTAssertEqual(en.company, "Pathors")
        XCTAssertEqual(en.name, "Ming")
    }

    func testCompanyAndNameAlwaysBecomeTerms() {
        let plain = MicIntro.complete(.plain("我是派斯科技的王小明，我主要用 Parley"), transcript: "我是派斯科技的王小明，我主要用 Parley")
        XCTAssertEqual(plain.terms, ["派斯科技", "王小明"])
        let modeled = MicIntro.complete(
            MicIntro.Summary(background: ["x"], terms: ["Parley"], name: "Ming", company: "Pathors"),
            transcript: "我是別家公司的人")
        XCTAssertEqual(modeled.terms, ["Parley", "Pathors", "Ming"], "the model's names win over the script's")
    }

    // MARK: the background

    func testAppendKeepsWhatIsThereAndSkipsLinesItHas() {
        let before = "• 我是設計師\n\n常和東森談外撥  \n"
        let out = MicIntro.append(["我是設計師", "主要用 Parley 整理客戶會議"], to: before)
        XCTAssertEqual(out.text, "• 我是設計師\n\n常和東森談外撥\n主要用 Parley 整理客戶會議")
        XCTAssertEqual(out.lines, ["主要用 Parley 整理客戶會議"])
        XCTAssertEqual(MicIntro.append(["a"], to: "").text, "a")
        XCTAssertEqual(MicIntro.append(["- a"], to: "a").lines, [], "nothing new, nothing changed")
    }

    func testRemoveTakesOutOnlyThoseLines() {
        let bg = "• 我是設計師\n\n常和東森談外撥\n主要用 Parley 整理客戶會議"
        XCTAssertEqual(MicIntro.remove(["主要用 Parley 整理客戶會議"], from: bg), "• 我是設計師\n\n常和東森談外撥")
        XCTAssertEqual(MicIntro.remove([], from: bg), bg)
    }

    func testARetestReplacesThePreviousRun() {
        let first = MicIntro.append(["我是派斯科技的設計師"], to: "我的筆記")
        let undone = MicIntro.remove(first.lines, from: first.text)
        let second = MicIntro.append(["我是派斯科技的設計總監"], to: undone)
        XCTAssertEqual(second.text, "我的筆記\n我是派斯科技的設計總監")
    }

    // MARK: the model

    func testTheAnswerIsCleanedAndCapped() {
        let content = """
            Sure: {"name":" 王小明 ","company":"派斯科技","role":"設計師",
            "background":["- 派斯科技的設計師","用 Parley 整理客戶會議","用 Parley 整理客戶會議","a","b"],
            "terms":["派斯科技","王小明"]}
            """
        let s = MicIntro.parse(content, transcript: "said")
        XCTAssertEqual(s?.background, ["派斯科技的設計師", "用 Parley 整理客戶會議", "a"])
        XCTAssertEqual(s?.terms, ["派斯科技", "王小明"])
        XCTAssertEqual(s?.name, "王小明")
    }

    func testAnEmptyOrUnreadableAnswerFallsBackToTheSentence() {
        XCTAssertEqual(MicIntro.parse(#"{"background":[]}"#, transcript: "我是小明")?.background, ["我是小明"])
        XCTAssertNil(MicIntro.parse("no json here", transcript: "我是小明"))
        XCTAssertEqual(MicIntro.Summary.plain("  ").background, [])
    }

    func testTheRequestCarriesTheDesktopPromptAndLanguage() {
        let r = MicIntro.request(transcript: "我是小明", chinese: true)
        XCTAssertEqual(r.messages.first?.role, "system")
        XCTAssertTrue(r.messages[0].content.hasPrefix("The user introduced themself out loud"))
        XCTAssertTrue(r.messages[0].content.contains("Traditional Chinese (繁體中文)"))
        XCTAssertEqual(r.messages[1].content, "TRANSCRIPT:\n我是小明")
        XCTAssertTrue(MicIntro.request(transcript: "x", chinese: false).messages[0].content.contains("in English"))
    }
}
