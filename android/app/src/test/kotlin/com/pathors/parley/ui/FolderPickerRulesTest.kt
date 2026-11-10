package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.library.FolderScope
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.ui.FolderPickerRules.CreateAction
import com.pathors.parley.ui.FolderPickerRules.Item
import com.pathors.parley.ui.FolderPickerRules.SubmitAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the folder picker does with a query or a typed name: the keyboard's
 * Return, the Create button, and which rows stand in when nothing matches.
 */
class FolderPickerRulesTest {

    private val folders = listOf(
        CloudFolder(id = "f1", name = NORTHWIND),
        CloudFolder(id = "f2", name = ACME),
    )

    @Test
    fun `return with nothing typed does nothing`() {
        assertEquals(SubmitAction.NOTHING, FolderPickerRules.submitAction("", 1, canCreate = true))
    }

    @Test
    fun `return with exactly one match selects it`() {
        assertEquals(SubmitAction.SELECT_ONLY_MATCH, FolderPickerRules.submitAction("north", 1, canCreate = false))
    }

    @Test
    fun `return with no match opens create only where there is one`() {
        assertEquals(SubmitAction.OPEN_CREATE, FolderPickerRules.submitAction(GLOBEX, 0, canCreate = true))
        assertEquals(SubmitAction.NOTHING, FolderPickerRules.submitAction(GLOBEX, 0, canCreate = false))
    }

    @Test
    fun `return with several matches waits for a tap`() {
        assertEquals(SubmitAction.NOTHING, FolderPickerRules.submitAction("o", 2, canCreate = true))
    }

    @Test
    fun `create with an existing name selects that folder instead`() {
        assertEquals(
            CreateAction.SelectExisting("f1"),
            FolderPickerRules.createAction("  northwind ", folders, canCreate = true, busy = false),
        )
    }

    @Test
    fun `create sends the normalized name`() {
        assertEquals(
            CreateAction.Create(GLOBEX),
            FolderPickerRules.createAction("  $GLOBEX  ", folders, canCreate = true, busy = false),
        )
    }

    @Test
    fun `create is ignored while busy, with no name, or with no endpoint`() {
        assertEquals(CreateAction.Ignore, FolderPickerRules.createAction(GLOBEX, folders, true, busy = true))
        assertEquals(CreateAction.Ignore, FolderPickerRules.createAction("   ", folders, true, busy = false))
        assertEquals(CreateAction.Ignore, FolderPickerRules.createAction(GLOBEX, folders, false, busy = false))
    }

    @Test
    fun `the create row names the search only when it matches nothing`() {
        assertTrue(FolderPickerRules.offersNamedCreate(GLOBEX, 0))
        assertFalse(FolderPickerRules.offersNamedCreate("", 0))
        assertFalse(FolderPickerRules.offersNamedCreate("north", 1))
    }

    @Test
    fun `no match shows only when there is no row and no create row`() {
        val one = listOf(Item.Place(SaveDestination.PERSONAL_ROOT, "Unfiled", isRoot = true))
        assertTrue(FolderPickerRules.showsNoMatch(emptyList(), canCreate = false))
        assertFalse(FolderPickerRules.showsNoMatch(one, canCreate = false))
        assertFalse(FolderPickerRules.showsNoMatch(emptyList(), canCreate = true))
    }

    // ── sections ─────────────────────────────────────────────────────────────

    private val team = CloudOrg(id = "o1", name = "Pathors")
    private val teamFolders = listOf(CloudFolder(id = "t1", name = PIPELINE, orgId = "o1"))
    private val scopes = listOf(FolderScope(null, folders), FolderScope(team, teamFolders))
    private fun root(scope: FolderScope) = if (scope.org == null) "Unfiled" else "No folder"

    private fun items(query: String = "", suggested: List<CloudFolder> = emptyList(), showsRoot: Boolean = true) =
        FolderPickerRules.items(scopes, query, suggested, ::root, showsRoot)

    @Test
    fun `personal and organization folders are listed under their own headers`() {
        assertEquals(
            listOf(
                Item.ScopeHeader(null),
                Item.Place(SaveDestination.PERSONAL_ROOT, "Unfiled", isRoot = true),
                Item.Place(SaveDestination(folderId = "f1"), NORTHWIND),
                Item.Place(SaveDestination(folderId = "f2"), ACME),
                Item.ScopeHeader(team),
                Item.Place(SaveDestination(orgId = "o1"), "No folder", isRoot = true),
                Item.Place(SaveDestination(orgId = "o1", folderId = "t1"), PIPELINE),
            ),
            items(),
        )
    }

    @Test
    fun `a search keeps a header only over a scope with a match`() {
        assertEquals(
            listOf(
                Item.ScopeHeader(null),
                Item.Place(SaveDestination(folderId = "f2"), ACME),
                Item.ScopeHeader(team),
                Item.Place(SaveDestination(orgId = "o1", folderId = "t1"), PIPELINE),
            ),
            items("acme"),
        )
        assertEquals(
            listOf(Item.ScopeHeader(null), Item.Place(SaveDestination(folderId = "f1"), NORTHWIND)),
            items("north"),
        )
        assertEquals(
            "Return counts the org folder as a match like any other",
            listOf(SaveDestination(folderId = "f2"), SaveDestination(orgId = "o1", folderId = "t1")),
            FolderPickerRules.folderMatches(items("acme")),
        )
    }

    @Test
    fun `suggested folders lead, and roots are left out where they are no answer`() {
        assertEquals(
            listOf(
                Item.SuggestedHeader,
                Item.Place(SaveDestination(folderId = "f2"), ACME, suggested = true),
                Item.ScopeHeader(null),
                Item.Place(SaveDestination(folderId = "f1"), NORTHWIND),
                Item.Place(SaveDestination(folderId = "f2"), ACME),
                Item.ScopeHeader(team),
                Item.Place(SaveDestination(orgId = "o1", folderId = "t1"), PIPELINE),
            ),
            items(suggested = listOf(folders[1], CloudFolder(id = "gone", name = "Deleted")), showsRoot = false),
        )
    }

    @Test
    fun `confirm needs a selection that is somewhere else`() {
        val here = SaveDestination(folderId = "f1")
        assertFalse(FolderPickerRules.canConfirm(null, here))
        assertFalse(FolderPickerRules.canConfirm(here, here))
        assertTrue(FolderPickerRules.canConfirm(SaveDestination(orgId = "o1", folderId = "t1"), here))
        assertTrue("nowhere yet, anywhere is a move", FolderPickerRules.canConfirm(here, null))
    }
}

private const val GLOBEX = "Globex"
private const val ACME = "Acme Corp"
private const val NORTHWIND = "Northwind"
private const val PIPELINE = "Acme pipeline"
