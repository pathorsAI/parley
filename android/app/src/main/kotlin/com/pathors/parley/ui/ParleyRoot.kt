package com.pathors.parley.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.screenshot.DemoMode

/** The four places the app can be. */
private object Route {
    const val HOME = "home"
    const val MEETING = "meeting"
    const val IMPORT = "import"
    const val RECORDING = "recording/{id}"

    fun recording(id: String) = "recording/$id"
}

/**
 * The whole UI: a sign-in wall in front of a four-screen navigation graph.
 *
 * The wall is driven by whether a token is *stored*, not by whether the cloud
 * answered — being offline must never look like being signed out (see
 * `AuthManager.isSignedIn`). A dead session comes back as a 401, which clears the
 * token from one place and swaps this back to the sign-in screen on its own.
 *
 * The one exception is [DemoMode], which stands the wall down without a token so
 * the store screenshots can be captured. It is debug-only and writes nothing.
 */
@Composable
fun ParleyRoot() {
    val container = rememberContainer()
    val signedIn by container.auth.isSignedIn.collectAsState(initial = null)
    val demo by DemoMode.enabled.collectAsState()

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when {
            demo -> ParleyNavHost(container)
            signedIn == null ->
                Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }

            signedIn == false -> SignInScreen(container)
            else -> ParleyNavHost(container)
        }
    }
}

@Composable
private fun ParleyNavHost(container: AppContainer) {
    val navController = rememberNavController()
    val context = LocalContext.current

    DemoNavigation(navController)

    // The Storage Access Framework: no storage permission, any provider (Files,
    // Drive, a recorder app), and the grant lives as long as we need the Uri.
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            container.startImport(uri, displayNameOf(context, uri))
            navController.navigate(Route.IMPORT)
        }
    }

    NavHost(navController = navController, startDestination = Route.HOME) {
        composable(Route.HOME) {
            HomeScreen(
                onRecord = { navController.navigate(Route.MEETING) },
                onImport = { picker.launch(arrayOf("audio/*")) },
                onOpenRecording = { id -> navController.navigate(Route.recording(id)) },
            )
        }
        composable(Route.MEETING) {
            MeetingScreen(onDone = { navController.popBackStack(Route.HOME, inclusive = false) })
        }
        composable(Route.IMPORT) {
            ImportScreen(onDone = { navController.popBackStack(Route.HOME, inclusive = false) })
        }
        composable(Route.RECORDING) { entry ->
            RecordingDetailScreen(
                recordingId = entry.arguments?.getString("id").orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }
    }
}

/**
 * Drives the navigation graph from `parley://demo/…`, so a screenshot run is a
 * list of URLs rather than a list of taps (input automation on an emulator is
 * unreliable; `am start` is not).
 *
 * The account route only has to reach the library — [HomeScreen] watches the same
 * cue and opens its account sheet.
 */
@Composable
private fun DemoNavigation(navController: NavHostController) {
    val navigation by DemoMode.navigation.collectAsState()
    LaunchedEffect(navigation) {
        val target = navigation ?: return@LaunchedEffect
        navController.popBackStack(Route.HOME, inclusive = false)
        when (target.screen) {
            DemoMode.Screen.LIBRARY, DemoMode.Screen.ACCOUNT -> Unit
            DemoMode.Screen.TRANSCRIPT -> navController.navigate(Route.recording(DemoMode.FEATURED_ID))
            DemoMode.Screen.MEETING -> navController.navigate(Route.MEETING)
        }
    }
}

/** The picked file's own name, which becomes the recording's title. */
private fun displayNameOf(context: Context, uri: Uri): String {
    val fromProvider = runCatching {
        context.contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
            }
    }.getOrNull()
    val name = fromProvider ?: uri.lastPathSegment?.substringAfterLast('/')
    return name?.takeIf { it.isNotBlank() } ?: context.getString(R.string.recording_untitled)
}
