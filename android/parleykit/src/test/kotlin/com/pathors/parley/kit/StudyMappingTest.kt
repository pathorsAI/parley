package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The desktop's mapping rules for what the model answers — see [StudyMapping]. */
class StudyMappingTest {

    private val segments = listOf(
        TranscriptSegment("mix-0", "mix", 1, "Hello there.", true, 0, 4_000),
        TranscriptSegment("mix-1", "mix", 2, "The budget is fixed.", true, 8_900, 12_000),
        TranscriptSegment("mix-2", "mix", 1, "   ", true, 13_000, 14_000),
        TranscriptSegment("mix-3", "mix", 2, "Let's ship in November.", true, 65_400, 70_000),
    )

    private val evals = listOf(EvalDef("pushback", "Push back", "p"), EvalDef("claims", "Claims", "c"))
    private fun id(i: Int) = "id-$i"

    // ── clocks ───────────────────────────────────────────────────────────────

    @Test
    fun `clocks parse as m-ss and h-mm-ss, bracketed or not`() {
        assertEquals(8_000L, StudyMapping.parseClockMs("[0:08]"))
        assertEquals(65_000L, StudyMapping.parseClockMs("1:05"))
        assertEquals(3_723_000L, StudyMapping.parseClockMs("[1:02:03]"))
        assertEquals(754_000L, StudyMapping.parseClockMs("around 12:34 or so"))
        // Past 100 minutes, as m+:ss — not 2:30.
        assertEquals(6_150_000L, StudyMapping.parseClockMs("[102:30]"))
        assertEquals(60_000_000L, StudyMapping.parseClockMs("1000:00"))
        assertEquals(6_150_000L, StudyMapping.parseClockMs("[1:42:30]"))
        assertNull(StudyMapping.parseClockMs("soon"))
        assertNull(StudyMapping.parseClockMs(""))
        assertNull(StudyMapping.parseClockMs(null))
    }

    @Test
    fun `a cited clock snaps to the line that displays it`() {
        // "[0:08]" names the line starting at 8.9 s.
        assertEquals(8_900L, StudyMapping.snapToSegment(8_000, segments))
    }

    @Test
    fun `otherwise to the line in progress, then the nearest, never a blank one`() {
        assertEquals(8_900L, StudyMapping.snapToSegment(10_000, segments))
        assertEquals(8_900L, StudyMapping.snapToSegment(13_000, segments))
        assertEquals(65_400L, StudyMapping.snapToSegment(80_000, segments))
        assertEquals(5_000L, StudyMapping.snapToSegment(5_000, emptyList()))
    }

    // ── findings ─────────────────────────────────────────────────────────────

    private fun events(json: String, lens: AnalysisLens) =
        StudyMapping.timelineEvents(json, segments, evals, lens, ::id)

    @Test
    fun `moments are placed, snapped and sorted, ids stay with their index`() {
        val out = events(
            """{"moments":[
              {"time":"[1:05]","side":"them","severity":"warn","source":"extra","evalIds":[],"title":"Ship date","detail":"November."},
              {"time":"[0:08]","side":"them","severity":"critical","source":"eval","evalIds":["pushback","bogus"],"title":"Budget","detail":"Fixed."}
            ]}""",
            AnalysisLens.OPPORTUNITY,
        )!!
        assertEquals(listOf("id-1", "id-0"), out.map { it.id })
        assertEquals(listOf(8_900L, 65_400L), out.map { it.atMs })
        assertEquals("eval", out[0].source)
        assertEquals(listOf("pushback"), out[0].evalIds)
        assertEquals("extra", out[1].source)
        assertNull(out[1].evalIds)
    }

    @Test
    fun `an eval moment whose ids all miss the configured set becomes extra`() {
        val out = events(
            """{"moments":[{"time":"0:08","category":"open","severity":"info","source":"eval","evalIds":["nope"],"title":"T","detail":"D"}]}""",
            AnalysisLens.DECISION,
        )!!
        assertEquals("extra", out.single().source)
        assertNull(out.single().evalIds)
    }

    @Test
    fun `a moment more than five seconds past the last line is dropped`() {
        val out = events(
            """{"moments":[
              {"time":"1:15","category":"fact","severity":"info","source":"extra","evalIds":[],"title":"In","detail":"D"},
              {"time":"1:16","category":"fact","severity":"info","source":"extra","evalIds":[],"title":"Out","detail":"D"}
            ]}""",
            AnalysisLens.DECISION,
        )!!
        // The last line ends at 70 s: 75 s is the limit.
        assertEquals(listOf("In"), out.map { it.title })
    }

    @Test
    fun `a moment missing what its lens renders is dropped`() {
        val noSide = """{"moments":[{"time":"0:08","severity":"info","source":"extra","evalIds":[],"title":"T","detail":"D"}]}"""
        assertTrue(events(noSide, AnalysisLens.ADVERSARIAL)!!.isEmpty())
        assertTrue(events(noSide, AnalysisLens.DECISION)!!.isEmpty())
        val noTime = """{"moments":[{"category":"fact","severity":"info","source":"extra","evalIds":[],"title":"T","detail":"D"}]}"""
        assertTrue(events(noTime, AnalysisLens.DECISION)!!.isEmpty())
        val badSeverity = """{"moments":[{"time":"0:08","category":"fact","severity":"high","source":"extra","evalIds":[],"title":"T","detail":"D"}]}"""
        assertTrue(events(badSeverity, AnalysisLens.DECISION)!!.isEmpty())
    }

    @Test
    fun `fields outside the lens are not kept`() {
        val out = events(
            """{"moments":[{"time":"0:08","side":"me","category":"open","severity":"info","source":"extra","evalIds":[],"title":"T","detail":"D","resolved":true,"resolution":"Handled."}]}""",
            AnalysisLens.DECISION,
        )!!.single()
        assertNull(out.side)
        assertEquals("open", out.category)
        assertNull(out.resolved)
        assertNull(out.resolution)
    }

    @Test
    fun `resolved needs a resolution line, and only the adversarial lens has it`() {
        val withHow = """{"moments":[{"time":"0:08","side":"them","severity":"warn","source":"extra","evalIds":[],"title":"T","detail":"D","resolved":true,"resolution":"  Traded for term. "}]}"""
        val adversarial = events(withHow, AnalysisLens.ADVERSARIAL)!!.single()
        assertEquals(true, adversarial.resolved)
        assertEquals("Traded for term.", adversarial.resolution)
        assertNull(events(withHow, AnalysisLens.OPPORTUNITY)!!.single().resolved)

        val noHow = withHow.replace("  Traded for term. ", "")
        val bare = events(noHow, AnalysisLens.ADVERSARIAL)!!.single()
        assertNull(bare.resolved)
        assertNull(bare.resolution)
    }

    @Test
    fun `an answer in a code fence after a preamble still parses`() {
        val out = events(
            "Sure, here you go:\n```json\n{\"moments\":[{\"time\":\"0:08\",\"category\":\"decision\",\"severity\":\"info\",\"source\":\"extra\",\"evalIds\":[],\"title\":\"T\",\"detail\":\"D\"}]}\n```",
            AnalysisLens.DECISION,
        )
        assertEquals(1, out!!.size)
    }

    @Test
    fun `an answer with no moments array is a failure, an empty one is not`() {
        assertNull(events("I could not find anything.", AnalysisLens.DECISION))
        assertNull(events("""{"findings":[]}""", AnalysisLens.DECISION))
        assertEquals(emptyList<TimelineEvent>(), events("""{"moments":[]}""", AnalysisLens.DECISION))
    }

    // ── action items ─────────────────────────────────────────────────────────

    private val finding = TimelineEvent(
        id = "f1", atMs = 8_900, side = "them", severity = "warn", source = "extra", title = "Budget", detail = "D",
    )

    @Test
    fun `an action item takes its moment and colour from the finding it links`() {
        val out = StudyMapping.actionItems(
            """{"actions":[
              {"text":"Send the quote","linkedEventId":"f1","time":"1:05"},
              {"text":"Book the demo","linkedEventId":"ghost","time":"1:05"},
              {"text":"Think it over","linkedEventId":null,"time":null},
              {"text":"","linkedEventId":null,"time":null}
            ]}""",
            listOf(finding),
            ::id,
        )!!
        assertEquals(3, out.size)
        assertEquals(ActionItem("id-0", "Send the quote", false, "f1", 8_900, "warn"), out[0])
        assertEquals(ActionItem("id-1", "Book the demo", false, null, 65_000, null), out[1])
        assertEquals(ActionItem("id-2", "Think it over", false, null, null, null), out[2])
    }

    @Test
    fun `no actions array is a failure`() {
        assertNull(StudyMapping.actionItems("""{"items":[]}""", emptyList(), ::id))
    }

    // ── delivery and kind ────────────────────────────────────────────────────

    @Test
    fun `a delivery answer maps onto the desktop's assessment`() {
        val out = StudyMapping.deliveryAssessment(
            """{"tone":"firm","tone_evidence":" We can't go lower. ","filler_level":"frequent","filler_examples":["就是"," ", "然後"],"filler_note":"Mid-call.","pace":"fast","summary":" Clear and direct. "}""",
        )!!
        assertEquals(
            DeliveryAssessment("firm", "We can't go lower.", FillerAssessment("frequent", listOf("就是", "然後"), "Mid-call."), "fast", "Clear and direct."),
            out,
        )
    }

    @Test
    fun `a delivery answer outside the schema's values is unusable, an odd pace is dropped`() {
        assertNull(StudyMapping.deliveryAssessment("""{"tone":"angry","filler_level":"ok","pace":"fast","summary":""}"""))
        assertNull(StudyMapping.deliveryAssessment("""{"tone":"warm","filler_level":"lots","pace":"fast","summary":""}"""))
        assertNull(StudyMapping.deliveryAssessment("""{"tone":"warm","filler_level":"ok","pace":"brisk","summary":""}""")!!.pace)
    }

    @Test
    fun `the meeting kind is one of four or nothing`() {
        assertEquals(MeetingKind.PRICING, StudyMapping.meetingKind("""{"kind":"pricing"}"""))
        assertNull(StudyMapping.meetingKind("""{"kind":"negotiation"}"""))
        assertNull(StudyMapping.meetingKind("pricing"))
    }

    // ── what is written back ─────────────────────────────────────────────────

    @Test
    fun `artifacts are written in the desktop's shape`() {
        val event = TimelineEvent(
            id = "e", atMs = 8_900, side = "them", severity = "warn", source = "eval", evalIds = listOf("pushback"),
            title = "T", detail = "D", resolved = true, resolution = "R",
        )
        assertEquals(
            """{"id":"e","atMs":8900,"side":"them","severity":"warn","source":"eval","evalIds":["pushback"],"title":"T","detail":"D","resolved":true,"resolution":"R"}""",
            event.toJson().toString(),
        )
        assertEquals(
            """{"id":"a","text":"Do it","done":false,"linkedEventId":null,"atMs":null}""",
            ActionItem("a", "Do it").toJson().toString(),
        )
        val delivery = DeliveryAssessment("warm", "", FillerAssessment("ok", emptyList(), ""), "comfortable", "Fine.")
        assertEquals(
            """{"tone":"warm","toneEvidence":"","fillers":{"level":"ok","examples":[],"note":""},"pace":"comfortable","summary":"Fine."}""",
            delivery.toJson().toString(),
        )
    }

    @Test
    fun `stored artifacts read back, tolerating what another analyst wrote`() {
        val event = TimelineEvent(id = "e", atMs = 1, category = "open", severity = "info", source = "extra", title = "T", detail = "D")
        assertEquals(event, TimelineEvent.fromJson(event.toJson(), "x"))
        val stored = Json.parseToJsonElement("""{"title":"Only a title","atMs":12.7}""").jsonObject
        val read = TimelineEvent.fromJson(stored, "finding-3")!!
        assertEquals("finding-3", read.id)
        assertEquals(12L, read.atMs)
        assertEquals("info", read.severity)
        assertNull(TimelineEvent.fromJson(Json.parseToJsonElement("""{"detail":"no title"}""").jsonObject, "x"))

        val delivery = DeliveryAssessment("sharp", "Q", FillerAssessment("frequent", listOf("um"), "N"), null, "S")
        assertEquals(delivery, DeliveryAssessment.fromJson(delivery.toJson()))
        assertTrue(delivery.toneNeedsWatch)
        assertNull(DeliveryAssessment.fromJson(Json.parseToJsonElement("""{"tone":"loud"}""")))
    }
}
