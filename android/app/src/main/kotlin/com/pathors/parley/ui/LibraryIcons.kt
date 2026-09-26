package com.pathors.parley.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The four glyphs the library's folders and organizations need.
 *
 * The app depends on the core Material icon set only, which has no folder, no
 * tray and no group. Pulling in `material-icons-extended` for four paths would
 * add thousands of classes for R8 to strip, so these are the Material Symbols
 * paths (Apache 2.0, the same licence as the icon artifact) drawn by hand, at
 * the same 24dp grid the core icons use so they tint and size alike.
 */
internal object LibraryIcons {

    /** A closed folder — a folder chip, a card's folder name, a picker row. */
    val Folder: ImageVector by lazy {
        icon(
            "Folder",
            "M10,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V8" +
                "c0,-1.1 -0.9,-2 -2,-2h-8l-2,-2z",
        )
    }

    /** A folder with a plus — "New folder…". */
    val NewFolder: ImageVector by lazy {
        icon(
            "NewFolder",
            "M20,6h-8l-2,-2H4c-1.11,0 -1.99,0.89 -1.99,2L2,18c0,1.11 0.89,2 2,2h16" +
                "c1.11,0 2,-0.89 2,-2V8c0,-1.11 -0.89,-2 -2,-2zM19,14h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z",
        )
    }

    /** An inbox tray — Unfiled, the recordings in no folder (iOS uses `tray`). */
    val Unfiled: ImageVector by lazy {
        icon(
            "Unfiled",
            "M19,3H4.99c-1.11,0 -1.98,0.89 -1.98,2L3,19c0,1.1 0.88,2 1.99,2H19c1.1,0 2,-0.9 2,-2V5" +
                "c0,-1.11 -0.9,-2 -2,-2zM19,15h-4c0,1.66 -1.35,3 -3,3s-3,-1.34 -3,-3H4.99V5H19v10z",
        )
    }

    /** Two people — an organization's library (iOS uses `person.2`). */
    val Group: ImageVector by lazy {
        icon(
            "Group",
            "M16,11c1.66,0 2.99,-1.34 2.99,-3S17.66,5 16,5c-1.66,0 -3,1.34 -3,3s1.34,3 3,3z" +
                "M8,11c1.66,0 2.99,-1.34 2.99,-3S9.66,5 8,5C6.34,5 5,6.34 5,8s1.34,3 3,3z" +
                "M8,13c-2.33,0 -7,1.17 -7,3.5V19h14v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5z" +
                "M16,13c-0.29,0 -0.62,0.02 -0.97,0.05 1.16,0.84 1.97,1.97 1.97,3.45V19h6v-2.5" +
                "c0,-2.33 -4.67,-3.5 -7,-3.5z",
        )
    }

    private fun icon(name: String, path: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = addPathNodes(path),
            fill = SolidColor(Color.Black),
        ).build()
}
