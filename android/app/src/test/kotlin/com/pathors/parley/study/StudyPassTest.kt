package com.pathors.parley.study

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.kit.ChatCompletions
import com.pathors.parley.kit.FilingLanguage
import com.pathors.parley.kit.StageStatus
import com.pathors.parley.kit.StudyArtifact
import com.pathors.parley.kit.StudyPrompts
import java.io.IOException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The study pass against a fake cloud and a fake model: the order the stages
 * run in, what each writes into the meta, and the three ways it backs off —
 * a result already there, a result another device wrote while this one was
 * thinking, and a failure or timeout that must never leave a stage running.
 */
class StudyPassTest {

    private val id = "rec-1"

    private fun baseMeta(extra: JsonObject = JsonObject(emptyMap())): RecordingMeta = RecordingMeta(
        JsonObject(
            buildJsonObject {
                put("id", id)
                put("title", "Renewal")
                put("source", "live")
                put("createdAt", 1)
                put("durationMs", 70_000)
                put("meetingContext", "Renewal with Acme.")
                put("unknownDesktopField", "keep me")
                put(
                    "segments",
                    buildJsonArray {
                        add(segment("mix-0", 1, "The budget is forty seats.", 0, 4_000))
                        add(segment("mix-1", 2, "Um, we quoted eighty.", 8_900, 12_000))
                        add(segment("mix-2", 1, "Let's hold the price.", 65_000, 70_000))
                    },
                )
            } + extra,
        ),
    )

    private fun segment(id: String, speaker: Int, text: String, start: Long, end: Long) = buildJsonObject {
        put("id", id)
        put("source", "mix")
        put("speaker", speaker)
        put("text", text)
        put("isFinal", true)
        put("startMs", start)
        put("endMs", end)
    }

    /** The cloud: one meta, read-modify-write with an optional "another device wrote" hook. */
    private class FakeCloud(var meta: RecordingMeta) : StudyCloud {
        var writes = 0
        var beforeWrite: (() -> Unit)? = null

        override suspend fun meta(recordingId: String): RecordingMeta = meta

        override suspend fun editIf(recordingId: String, edit: (RecordingMeta) -> RecordingMeta?): RecordingMeta? {
            beforeWrite?.invoke()
            beforeWrite = null
            val edited = edit(meta) ?: return null
            writes++
            meta = edited
            return edited
        }
    }

    /** The model: answers by stage, recognised from the request's model and system prompt. */
    private class FakeModel : ChatCompletions {
        val asked = mutableListOf<String>()
        val models = mutableListOf<String>()
        var answers: MutableMap<String, suspend () -> String> = mutableMapOf(
            "kind" to { """{"kind":"pricing"}""" },
            "findings" to {
                """{"moments":[{"time":"[0:08]","side":"them","severity":"warn","source":"eval","evalIds":["zopa"],"title":"Seat gap","detail":"Forty against eighty."}]}"""
            },
            "actions" to { """{"actions":[{"text":"Send the revised quote","linkedEventId":null,"time":"1:05"}]}""" },
            "brief" to { "## Outcome\nPrice held [1:05]." },
            "delivery" to {
                """{"tone":"firm","tone_evidence":"hold the price","filler_level":"ok","filler_examples":[],"filler_note":"","pace":"comfortable","summary":"Steady."}"""
            },
        )

        override suspend fun chatCompletion(requestJson: String): String {
            val body = Json.parseToJsonElement(requestJson).jsonObject
            val model = body["model"]!!.jsonPrimitive.content
            val system = body["messages"]!!.jsonArray[0].jsonObject["content"]!!.jsonPrimitive.content
            val stage = when {
                system.startsWith("Classify a finished meeting") -> "kind"
                system.contains("\"moments\"") -> "findings"
                system.contains("\"actions\"") -> "actions"
                system.contains("delivery coach") -> "delivery"
                else -> "brief"
            }
            asked += stage
            models += "$stage:$model"
            val content = answers.getValue(stage)()
            return buildJsonObject {
                put("choices", buildJsonArray { add(buildJsonObject { put("message", buildJsonObject { put("content", content) }) }) })
            }.toString()
        }
    }

    private var ids = 0

    private fun TestScope.pass(
        cloud: FakeCloud,
        model: FakeModel,
        auto: Boolean = true,
        signedIn: Boolean = true,
    ) = StudyPass(
        cloud = cloud,
        chat = model,
        scope = this,
        language = { FilingLanguage.EN },
        fallbackSpeakerLabel = { _, speaker -> "Speaker $speaker" },
        autoAnalysis = { auto },
        canSpend = { signedIn },
        newId = { "id-${ids++}" },
        timeoutMs = { 1_000L },
    )

    private fun StudyPass.statuses() = state.value[id]!!.statuses

    @Test
    fun `a fresh recording runs the whole chain in order and writes the desktop's fields`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertTrue(pass.statuses().values.all { it == StageStatus.DONE })
        assertEquals("kind", model.asked.first())
        assertEquals("findings", model.asked[1])
        assertEquals("brief", model.asked.last())
        assertEquals(
            setOf(
                "kind:${StudyPrompts.MODEL_MEETING_KIND}",
                "findings:${StudyPrompts.MODEL_FINDINGS}",
                "actions:${StudyPrompts.MODEL_ACTION_ITEMS}",
                "brief:${StudyPrompts.MODEL_BRIEF}",
                "delivery:${StudyPrompts.MODEL_DELIVERY}",
            ),
            model.models.toSet(),
        )

        val raw = cloud.meta.raw
        assertEquals("pricing", raw["meetingKind"]!!.jsonPrimitive.content)
        val finding = raw["findings"]!!.jsonArray.single().jsonObject
        assertEquals(8_900L, finding["atMs"]!!.jsonPrimitive.content.toLong())
        assertEquals(listOf("zopa"), finding["evalIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        val action = raw["actionItems"]!!.jsonArray.single().jsonObject
        assertEquals(65_000L, action["atMs"]!!.jsonPrimitive.content.toLong())
        assertTrue(raw["analyzed"]!!.jsonPrimitive.boolean)
        assertEquals("## Outcome\nPrice held [1:05].", raw["brief"]!!.jsonPrimitive.content)
        assertFalse(raw["briefFailed"]!!.jsonPrimitive.boolean)
        assertEquals("firm", raw["deliveryAssessment"]!!.jsonObject["tone"]!!.jsonPrimitive.content)
        // Fields the phone knows nothing about survive every write.
        assertEquals("keep me", raw["unknownDesktopField"]!!.jsonPrimitive.content)
        // The summary the write derives counts what was written.
        assertEquals(1, cloud.meta.findingsCount)
        assertEquals(1, cloud.meta.actionItemsCount)
        // The screen gets the newest meta.
        assertTrue(pass.state.value[id]!!.meta === cloud.meta)
    }

    @Test
    fun `an analysed recording spends nothing`() = runTest {
        val cloud = FakeCloud(
            baseMeta(
                buildJsonObject {
                    put("analyzed", true)
                    put("findings", JsonArray(emptyList()))
                    put("actionItems", JsonArray(emptyList()))
                    put("brief", "Done already.")
                    put("deliveryAssessment", buildJsonObject { put("tone", "warm") })
                },
            ),
        )
        val model = FakeModel()
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertTrue(model.asked.isEmpty())
        assertEquals(0, cloud.writes)
        assertTrue(pass.statuses().values.all { it == StageStatus.DONE })
    }

    @Test
    fun `a kind set by hand is kept and not detected again`() = runTest {
        val cloud = FakeCloud(baseMeta(buildJsonObject { put("meetingKind", "internal") }))
        val model = FakeModel()
        model.answers["findings"] = {
            """{"moments":[{"time":"0:08","category":"decision","severity":"info","source":"extra","evalIds":[],"title":"Hold","detail":"Price held."}]}"""
        }
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertFalse("kind" in model.asked)
        assertEquals("internal", cloud.meta.raw["meetingKind"]!!.jsonPrimitive.content)
        assertEquals("decision", cloud.meta.raw["findings"]!!.jsonArray.single().jsonObject["category"]!!.jsonPrimitive.content)
    }

    @Test
    fun `findings another device wrote while this one was thinking are kept, not overwritten`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val theirs = buildJsonArray { add(buildJsonObject { put("id", "desktop-1"); put("title", "Theirs"); put("atMs", 1) }) }
        cloud.beforeWrite = { cloud.meta = RecordingMeta(JsonObject(cloud.meta.raw + ("findings" to theirs))) }
        val model = FakeModel()
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertEquals(StageStatus.DONE, pass.statuses()[StudyArtifact.FINDINGS])
        assertEquals("desktop-1", cloud.meta.raw["findings"]!!.jsonArray.single().jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a failed findings pass stops the chain and leaves nothing running`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        model.answers["findings"] = { throw IOException("offline") }
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        val study = pass.state.value[id]!!
        assertEquals(StageStatus.ERROR, study.statuses[StudyArtifact.FINDINGS])
        assertEquals(StudyFailure.NETWORK, study.failures[StudyArtifact.FINDINGS])
        assertEquals(StageStatus.IDLE, study.statuses[StudyArtifact.ACTIONS])
        assertFalse(study.anyRunning)
        assertNull(cloud.meta.raw["findings"])
    }

    @Test
    fun `a stage that times out lands as an error`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        model.answers["delivery"] = { awaitCancellation() }
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        val study = pass.state.value[id]!!
        assertEquals(StageStatus.ERROR, study.statuses[StudyArtifact.DELIVERY])
        assertEquals(StudyFailure.TIMEOUT, study.failures[StudyArtifact.DELIVERY])
        assertEquals(StageStatus.DONE, study.statuses[StudyArtifact.BRIEF])
        assertFalse(study.anyRunning)
    }

    @Test
    fun `an empty brief is a failure, and it is remembered on the recording`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        model.answers["brief"] = { "   " }
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertEquals(StageStatus.ERROR, pass.statuses()[StudyArtifact.BRIEF])
        assertEquals(StudyFailure.UNREADABLE, pass.state.value[id]!!.failures[StudyArtifact.BRIEF])
        assertTrue(cloud.meta.raw["briefFailed"]!!.jsonPrimitive.boolean)
        // ...and it restores as an error, not as something to run again on open.
        assertEquals(StageStatus.ERROR, StudyPass.restoredStatuses(cloud.meta)[StudyArtifact.BRIEF])
    }

    @Test
    fun `out of quota is told apart`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        model.answers["kind"] = { throw CloudException(402, "out of credits", "quota_exceeded") }
        model.answers["findings"] = { throw CloudException(402, "out of credits", "quota_exceeded") }
        val pass = pass(cloud, model)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertEquals(StudyFailure.QUOTA, pass.state.value[id]!!.failures[StudyArtifact.FINDINGS])
    }

    @Test
    fun `with auto-analysis off nothing runs until asked, and asking runs the chain`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model, auto = false)

        pass.open(id, cloud.meta)
        advanceUntilIdle()
        assertTrue(model.asked.isEmpty())
        assertTrue(pass.statuses().values.all { it == StageStatus.IDLE })

        pass.regenerate(id, StudyArtifact.FINDINGS)
        advanceUntilIdle()
        assertTrue(pass.statuses().values.all { it == StageStatus.DONE })
    }

    @Test
    fun `signed out, nothing is spent`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model, signedIn = false)

        pass.open(id, cloud.meta)
        advanceUntilIdle()

        assertTrue(model.asked.isEmpty())
        assertFalse(pass.state.value[id]!!.progress.active)
    }

    @Test
    fun `regenerating one artifact replaces only that one`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model)
        pass.open(id, cloud.meta)
        advanceUntilIdle()
        model.asked.clear()

        model.answers["brief"] = { "A second brief." }
        pass.regenerate(id, StudyArtifact.BRIEF)
        advanceUntilIdle()

        assertEquals(listOf("brief"), model.asked)
        assertEquals("A second brief.", cloud.meta.raw["brief"]!!.jsonPrimitive.content)
    }

    @Test
    fun `regenerate all reruns findings, then everything downstream`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model)
        pass.open(id, cloud.meta)
        advanceUntilIdle()
        model.asked.clear()

        pass.regenerateAll(id)
        advanceUntilIdle()

        // The kind is already known now, so it is not asked again.
        assertEquals("findings", model.asked.first())
        assertEquals(setOf("findings", "actions", "delivery", "brief"), model.asked.toSet())
        assertTrue(pass.statuses().values.all { it == StageStatus.DONE })
    }

    @Test
    fun `regenerate all keeps the old outputs when the findings pass fails`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        val pass = pass(cloud, model)
        pass.open(id, cloud.meta)
        advanceUntilIdle()
        model.asked.clear()

        model.answers["findings"] = { "no json here" }
        pass.regenerateAll(id)
        advanceUntilIdle()

        assertEquals(listOf("findings"), model.asked)
        assertEquals(StageStatus.ERROR, pass.statuses()[StudyArtifact.FINDINGS])
        assertEquals(StageStatus.DONE, pass.statuses()[StudyArtifact.BRIEF])
        assertEquals("## Outcome\nPrice held [1:05].", cloud.meta.raw["brief"]!!.jsonPrimitive.content)
    }

    @Test
    fun `reopening while a stage runs does not start it twice`() = runTest {
        val cloud = FakeCloud(baseMeta())
        val model = FakeModel()
        var release: (() -> Unit)? = null
        model.answers["findings"] = {
            kotlinx.coroutines.suspendCancellableCoroutine<Unit> { c -> release = { c.resumeWith(Result.success(Unit)) } }
            """{"moments":[]}"""
        }
        val pass = StudyPass(
            cloud = cloud, chat = model, scope = this, language = { FilingLanguage.EN },
            fallbackSpeakerLabel = { _, s -> "S$s" }, autoAnalysis = { true }, canSpend = { true },
            newId = { "id-${ids++}" }, timeoutMs = { Long.MAX_VALUE / 4 },
        )
        // runCurrent, not advanceUntilIdle: virtual time must not reach the timeout.
        pass.open(id, cloud.meta)
        runCurrent()
        assertEquals(StageStatus.RUNNING, pass.statuses()[StudyArtifact.FINDINGS])

        pass.open(id, cloud.meta)
        runCurrent()
        assertEquals(StageStatus.RUNNING, pass.statuses()[StudyArtifact.FINDINGS])
        assertEquals(1, model.asked.count { it == "findings" })

        release!!.invoke()
        advanceUntilIdle()
        assertTrue(pass.statuses().values.all { it == StageStatus.DONE })
    }
}
