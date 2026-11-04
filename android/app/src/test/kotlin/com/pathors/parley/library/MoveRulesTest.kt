package com.pathors.parley.library

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where "Move to…" can take a recording, and what each move takes. The rule
 * that matters most is the last one: nothing here pretends a recording can
 * leave an organization, because the cloud has no call that does it.
 */
class MoveRulesTest {

    @Test
    fun `a personal recording refiles within the personal library`() {
        assertEquals(MovePlan.RefilePersonal("acme"), MoveRules.plan(null, null, SaveDestination(folderId = "acme")))
        assertEquals(MovePlan.RefilePersonal(null), MoveRules.plan(null, "acme", SaveDestination.PERSONAL_ROOT))
    }

    @Test
    fun `a personal recording moves into an organization's folder or root`() {
        assertEquals(
            MovePlan.MoveIntoOrg("o1", "pipeline"),
            MoveRules.plan(null, "acme", SaveDestination(orgId = "o1", folderId = "pipeline")),
        )
        assertEquals(MovePlan.MoveIntoOrg("o1", null), MoveRules.plan(null, null, SaveDestination(orgId = "o1")))
    }

    @Test
    fun `an org recording moves between its own organization's folders`() {
        assertEquals(
            MovePlan.RefileInOrg("o1", "pipeline"),
            MoveRules.plan("o1", null, SaveDestination(orgId = "o1", folderId = "pipeline")),
        )
        assertEquals(MovePlan.RefileInOrg("o1", null), MoveRules.plan("o1", "pipeline", SaveDestination(orgId = "o1")))
    }

    @Test
    fun `an org recording cannot leave its organization`() {
        assertEquals(MovePlan.Unsupported, MoveRules.plan("o1", null, SaveDestination(folderId = "acme")))
        assertEquals(MovePlan.Unsupported, MoveRules.plan("o1", null, SaveDestination(orgId = "o2")))
    }

    @Test
    fun `where it already is, nothing moves`() {
        assertEquals(MovePlan.Stay, MoveRules.plan(null, "acme", SaveDestination(folderId = "acme")))
        assertEquals(MovePlan.Stay, MoveRules.plan("o1", null, SaveDestination(orgId = "o1")))
    }

    // ── what the picker lists ────────────────────────────────────────────────

    private val team = CloudOrg(id = "o1", name = "Pathors")
    private val other = CloudOrg(id = "o2", name = "Globex")
    private val directory = FolderDirectory(
        personalFolders = listOf(CloudFolder(id = "acme", name = "Acme")),
        orgs = listOf(team, other),
        orgFolders = mapOf("o1" to listOf(CloudFolder(id = "pipeline", name = "Pipeline", orgId = "o1"))),
    )

    @Test
    fun `a personal recording is offered every library, personal first`() {
        assertEquals(
            listOf(
                FolderScope(null, listOf(CloudFolder(id = "acme", name = "Acme"))),
                FolderScope(team, listOf(CloudFolder(id = "pipeline", name = "Pipeline", orgId = "o1"))),
                FolderScope(other, emptyList()),
            ),
            directory.scopesFor(null),
        )
    }

    @Test
    fun `an org recording is offered its own organization only`() {
        assertEquals(
            listOf(FolderScope(team, listOf(CloudFolder(id = "pipeline", name = "Pipeline", orgId = "o1")))),
            directory.scopesFor("o1"),
        )
    }

    @Test
    fun `a created folder joins its scope once`() {
        val made = CloudFolder(id = "new", name = "New", orgId = "o2")
        val after = directory.withFolder("o2", made).withFolder("o2", made)
        assertEquals(listOf(made), after.orgFolders["o2"])
        assertEquals("Globex · New", "${after.orgName("o2")} · ${after.folderName(SaveDestination("o2", "new"))}")
    }
}
