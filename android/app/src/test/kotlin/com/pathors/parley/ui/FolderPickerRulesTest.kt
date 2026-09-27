package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.ui.FolderPickerRules.CreateAction
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
        CloudFolder(id = "f1", name = "Northwind"),
        CloudFolder(id = "f2", name = "Acme Corp"),
    )

    @Test
    fun `return with nothing typed does nothing`() {
        assertEquals(SubmitAction.NOTHING, FolderPickerRules.submitAction("", 1, canCreate = true))
    }

    @Test
    fun `return with exactly one match picks it`() {
        assertEquals(SubmitAction.PICK_ONLY_MATCH, FolderPickerRules.submitAction("north", 1, canCreate = false))
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
    fun `create with an existing name picks that folder instead`() {
        assertEquals(
            CreateAction.PickExisting("f1"),
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
    fun `no match shows only when there is no other row at all`() {
        assertTrue(FolderPickerRules.showsNoMatch(0, showsUnfiled = false, canCreate = false))
        assertFalse(FolderPickerRules.showsNoMatch(0, showsUnfiled = true, canCreate = false))
        assertFalse(FolderPickerRules.showsNoMatch(0, showsUnfiled = false, canCreate = true))
        assertFalse(FolderPickerRules.showsNoMatch(1, showsUnfiled = false, canCreate = false))
    }
}

private const val GLOBEX = "Globex"
