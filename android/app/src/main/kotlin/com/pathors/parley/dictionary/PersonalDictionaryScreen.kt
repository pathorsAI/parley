package com.pathors.parley.dictionary

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.pathors.parley.R
import com.pathors.parley.kit.Lexicon
import com.pathors.parley.kit.LexiconPair
import com.pathors.parley.kit.LexiconStore
import com.pathors.parley.kit.LexiconTerm
import com.pathors.parley.ui.SearchField
import com.pathors.parley.ui.rememberContainer
import kotlinx.coroutines.delay

/**
 * The personal dictionary, made visible — iOS `PersonalDictionaryView`.
 *
 * A feature that changes what Parley listens for has to be a list someone can
 * read and a row they can delete. This is where a person edits it: adding a
 * correction outright ("Add correction"), a term, editing or removing either,
 * or clearing the lot. Signed in, the dictionary also syncs with the account
 * and a line at the top says when it last did.
 *
 * Opened full screen over the account sheet rather than as a route: the sheet
 * is not on the nav graph either (see `AccountSheet`), and a pushed page over
 * it is what iOS does from Settings. Android adds a search, which iOS does not
 * have — the list syncs from the desktop and can run to hundreds of rows.
 *
 * Not here (iOS has them, Android does not yet): "Fix this word" from a
 * transcript, and the keyboard learning corrections from edits. Rows still
 * marked "Learning" can only arrive from an older file today, but the state is
 * drawn so the screen stays honest when the keyboard learns.
 */
@Composable
fun PersonalDictionaryScreen(onDismiss: () -> Unit) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val container = rememberContainer()
        val lexicon by container.lexicon.lexicon.collectAsState()
        val status by container.dictionarySync.status.collectAsState()
        val active by container.dictionarySync.active.collectAsState()
        DictionaryContent(
            lexicon = lexicon,
            syncStatus = status.takeIf { active && it != DictionarySyncModel.Status.Idle },
            store = container.lexicon,
            onClear = {
                // Before the clear is written, so the sync it schedules carries
                // it out rather than reading an emptied file as a lost one.
                container.dictionarySync.noteCleared()
                container.lexicon.removeAll()
            },
            onDismiss = onDismiss,
        )
    }
}

/** What is being edited in a dialog, if anything. */
private sealed interface DictionaryEdit {
    /** A new correction (no [old]) or a change to an existing one. */
    data class Correction(val old: LexiconPair?) : DictionaryEdit
    data class Term(val old: LexiconTerm) : DictionaryEdit
    data object Clear : DictionaryEdit
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DictionaryContent(
    lexicon: Lexicon,
    syncStatus: DictionarySyncModel.Status?,
    store: LexiconStore,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var edit by remember { mutableStateOf<DictionaryEdit?>(null) }
    val listing = DictionaryRules.filter(lexicon, if (searching) query else "")

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(stringResource(R.string.dictionary_title)) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                        }
                    },
                    actions = {
                        if (!searching && !lexicon.isEmpty) {
                            IconButton(onClick = { searching = true }) {
                                Icon(Icons.Default.Search, stringResource(R.string.dictionary_search))
                            }
                        }
                    },
                )
                if (searching) {
                    SearchField(
                        query = query,
                        onQueryChange = { query = it },
                        hint = stringResource(R.string.dictionary_search_hint),
                        onClose = {
                            searching = false
                            query = ""
                        },
                    )
                }
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = 24.dp,
                end = 24.dp,
                top = padding.calculateTopPadding() + 8.dp,
                bottom = padding.calculateBottomPadding() + 32.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            syncStatus?.let { item { SyncStatusLine(it) } }
            if (searching && query.isNotBlank()) {
                searchResults(listing, onEdit = { edit = it }, store = store)
            } else {
                correctionsSection(listing.pairs, onEdit = { edit = it }, store = store)
                termsSection(listing.terms, onEdit = { edit = it }, store = store)
                if (!lexicon.isEmpty) {
                    item {
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        TextButton(onClick = { edit = DictionaryEdit.Clear }) {
                            Text(stringResource(R.string.dictionary_clear), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }

    EditDialogs(edit, store, onClear, onDone = { edit = null })
}

@Composable
private fun EditDialogs(edit: DictionaryEdit?, store: LexiconStore, onClear: () -> Unit, onDone: () -> Unit) {
    when (edit) {
        null -> Unit
        is DictionaryEdit.Correction -> CorrectionDialog(
            old = edit.old,
            onSave = { original, replacement ->
                val old = edit.old
                if (old == null) {
                    store.recordConfirmed(original, replacement)
                } else {
                    store.replacePair(old.original, original, replacement)
                }
                onDone()
            },
            onDismiss = onDone,
        )
        is DictionaryEdit.Term -> TermDialog(
            old = edit.old,
            onSave = { text ->
                store.replaceTerm(edit.old.text, text)
                onDone()
            },
            onDismiss = onDone,
        )
        DictionaryEdit.Clear -> ClearDialog(
            onConfirm = {
                onClear()
                onDone()
            },
            onDismiss = onDone,
        )
    }
}

// ── sections ─────────────────────────────────────────────────────────────────

private fun LazyListScope.correctionsSection(
    pairs: List<LexiconPair>,
    onEdit: (DictionaryEdit) -> Unit,
    store: LexiconStore,
) {
    item { SectionHeader(R.string.dictionary_corrections_header) }
    item {
        TextButton(onClick = { onEdit(DictionaryEdit.Correction(null)) }) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.dictionary_add_correction), fontWeight = FontWeight.SemiBold)
        }
    }
    if (pairs.isEmpty()) {
        item { Muted(stringResource(R.string.dictionary_corrections_empty)) }
    }
    // Newest first, so a correction just added sits where its author looks.
    items(pairs, key = { "p:${it.original}" }) { pair ->
        CorrectionRow(pair, onEdit = { onEdit(DictionaryEdit.Correction(pair)) }, onDelete = {
            store.removePair(pair.original)
        })
    }
    item { Footer(R.string.dictionary_corrections_footer) }
}

private fun LazyListScope.termsSection(
    terms: List<LexiconTerm>,
    onEdit: (DictionaryEdit) -> Unit,
    store: LexiconStore,
) {
    item { SectionHeader(R.string.dictionary_terms_header) }
    item { AddTermRow(onAdd = store::addTerm) }
    items(terms, key = { "t:${it.text}" }) { term ->
        TermRow(term, onEdit = { onEdit(DictionaryEdit.Term(term)) }, onDelete = { store.removeTerm(term.text) })
    }
    item { Footer(R.string.dictionary_terms_footer) }
}

/** A search shows only the rows that match, both kinds, without the add controls. */
private fun LazyListScope.searchResults(
    listing: DictionaryRules.Listing,
    onEdit: (DictionaryEdit) -> Unit,
    store: LexiconStore,
) {
    if (listing.isEmpty) {
        item { Muted(stringResource(R.string.dictionary_no_matches)) }
        return
    }
    if (listing.pairs.isNotEmpty()) item { SectionHeader(R.string.dictionary_corrections_header) }
    items(listing.pairs, key = { "p:${it.original}" }) { pair ->
        CorrectionRow(pair, onEdit = { onEdit(DictionaryEdit.Correction(pair)) }, onDelete = {
            store.removePair(pair.original)
        })
    }
    if (listing.terms.isNotEmpty()) item { SectionHeader(R.string.dictionary_terms_header) }
    items(listing.terms, key = { "t:${it.text}" }) { term ->
        TermRow(term, onEdit = { onEdit(DictionaryEdit.Term(term)) }, onDelete = { store.removeTerm(term.text) })
    }
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * What was heard, an arrow, what was meant — and how many times it has been
 * confirmed. The count is the honest thing to show: it decides whether the row
 * is doing anything yet.
 */
@Composable
private fun CorrectionRow(pair: LexiconPair, onEdit: () -> Unit, onDelete: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = pair.original,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(
            Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = pair.replacement,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (pair.isConfirmed) {
            // A digit and a multiplication sign read the same in both languages.
            Text(
                text = "${pair.count}×",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                text = stringResource(R.string.dictionary_learning),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.tertiary,
            )
        }
        RowMenu(label = pair.replacement, onEdit = onEdit, onDelete = onDelete)
    }
}

@Composable
private fun TermRow(term: LexiconTerm, onEdit: () -> Unit, onDelete: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(term.text, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        RowMenu(label = term.text, onEdit = onEdit, onDelete = onDelete)
    }
}

/** Edit / Delete behind an overflow button — Android has no swipe-to-delete convention for lists like this. */
@Composable
private fun RowMenu(label: String, onEdit: () -> Unit, onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(Icons.Default.MoreVert, stringResource(R.string.dictionary_row_actions, label))
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.dictionary_edit)) },
            onClick = {
                open = false
                onEdit()
            },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.dictionary_delete), color = MaterialTheme.colorScheme.error) },
            onClick = {
                open = false
                onDelete()
            },
        )
    }
}

@Composable
private fun AddTermRow(onAdd: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val submit = {
        if (text.isNotBlank()) {
            onAdd(text)
            text = ""
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text(stringResource(R.string.dictionary_add_term_hint)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = submit, enabled = text.isNotBlank()) {
            Text(stringResource(R.string.dictionary_add), fontWeight = FontWeight.SemiBold)
        }
    }
}

// ── dialogs ──────────────────────────────────────────────────────────────────

/**
 * "Add correction" / "Edit correction" — iOS `LexiconCorrectionSheet` as a
 * dialog. Save stays off for any pair the dictionary would refuse, and the
 * footer says why when the reason is not obvious from two empty boxes.
 */
@Composable
private fun CorrectionDialog(old: LexiconPair?, onSave: (String, String) -> Unit, onDismiss: () -> Unit) {
    var original by rememberSaveable { mutableStateOf(old?.original.orEmpty()) }
    var replacement by rememberSaveable { mutableStateOf(old?.replacement.orEmpty()) }
    val problem = Lexicon.problem(original.trim(), replacement.trim())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(stringResource(if (old == null) R.string.dictionary_add_correction else R.string.dictionary_edit_correction))
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DialogField(original, { original = it }, R.string.dictionary_heard_as)
                DialogField(replacement, { replacement = it }, R.string.dictionary_should_be)
                Text(
                    text = stringResource(correctionFooter(problem)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(original, replacement) }, enabled = problem == null) {
                Text(stringResource(R.string.dictionary_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@StringRes
private fun correctionFooter(problem: Lexicon.PairProblem?): Int = when (problem) {
    Lexicon.PairProblem.SINGLE_CHARACTER -> R.string.dictionary_problem_single
    Lexicon.PairProblem.GROWS -> R.string.dictionary_problem_grows
    else -> R.string.dictionary_correction_footer
}

@Composable
private fun TermDialog(old: LexiconTerm, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(old.text) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dictionary_edit_term)) },
        text = { DialogField(text, { text = it }, R.string.dictionary_term) },
        confirmButton = {
            TextButton(onClick = { onSave(text) }, enabled = text.isNotBlank()) {
                Text(stringResource(R.string.dictionary_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun ClearDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dictionary_clear_title)) },
        text = { Text(stringResource(R.string.dictionary_clear_message)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.dictionary_clear_confirm), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun DialogField(value: String, onChange: (String) -> Unit, @StringRes label: Int) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(stringResource(label)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
}

// ── bits ─────────────────────────────────────────────────────────────────────

/**
 * 「已同步 · 剛剛」 — when the dictionary last synced, or that it could not.
 * Re-read every half minute so "just now" ages honestly.
 */
@Composable
private fun SyncStatusLine(status: DictionarySyncModel.Status) {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            nowMs = System.currentTimeMillis()
        }
    }
    val text = when (status) {
        is DictionarySyncModel.Status.Synced ->
            stringResource(R.string.dictionary_sync_synced, agoText(status.atMs, nowMs))
        is DictionarySyncModel.Status.Failed -> status.lastSyncedMs?.let {
            stringResource(R.string.dictionary_sync_failed_last, agoText(it, nowMs))
        } ?: stringResource(R.string.dictionary_sync_failed)
        else -> stringResource(R.string.dictionary_sync_syncing)
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = if (status is DictionarySyncModel.Status.Failed) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}

@Composable
private fun agoText(atMs: Long, nowMs: Long): String = when (val ago = DictionaryRules.ago(atMs, nowMs)) {
    DictionaryRules.Ago.JustNow -> stringResource(R.string.dictionary_ago_now)
    is DictionaryRules.Ago.Minutes -> stringResource(R.string.dictionary_ago_minutes, ago.n)
    is DictionaryRules.Ago.Hours -> stringResource(R.string.dictionary_ago_hours, ago.n)
    is DictionaryRules.Ago.Days -> stringResource(R.string.dictionary_ago_days, ago.n)
}

@Composable
private fun SectionHeader(@StringRes title: Int) {
    Text(
        text = stringResource(title),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun Footer(@StringRes text: Int) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 4.dp),
    )
}

@Composable
private fun Muted(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}
