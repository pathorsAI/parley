package com.pathors.parley.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The glyphs the library needs and the core icon set lacks: folders and
 * organizations, and the row's meta line (clock, findings, audio, on-phone).
 *
 * The app depends on the core Material icon set only, which has no folder, no
 * tray, no group, no clock and no lightbulb. Pulling in
 * `material-icons-extended` for a handful of paths would add thousands of
 * classes for R8 to strip, so these are the Material Symbols
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

    /** A phone — the audio is on this one (iOS `iphone`). */
    val Phone: ImageVector by lazy {
        icon(
            "Phone",
            "M17,1.01L7,1c-1.1,0 -1.99,0.9 -1.99,2v18c0,1.1 0.89,2 1.99,2h10c1.1,0 2,-0.9 2,-2V3" +
                "c0,-1.1 -0.9,-1.99 -2,-1.99zM17,19H7V5h10v14z",
        )
    }

    /**
     * A lightbulb, outlined — findings, the same glyph iOS puts on the row and
     * on the detail screen's findings section.
     */
    val Lightbulb: ImageVector by lazy {
        icon(
            "Lightbulb",
            "M9,21c0,0.55 0.45,1 1,1h4c0.55,0 1,-0.45 1,-1v-1L9,20v1zM12,2C8.14,2 5,5.14 5,9" +
                "c0,2.38 1.19,4.47 3,5.74L8,17c0,0.55 0.45,1 1,1h6c0.55,0 1,-0.45 1,-1v-2.26" +
                "c1.81,-1.27 3,-3.36 3,-5.74 0,-3.86 -3.14,-7 -7,-7zM14.85,13.1l-0.85,0.6L14,16h-4" +
                "v-2.3l-0.85,-0.6C7.8,12.16 7,10.63 7,9c0,-2.76 2.24,-5 5,-5s5,2.24 5,5" +
                "c0,1.63 -0.8,3.16 -2.15,4.1z",
        )
    }

    /** A speaker with sound — the recording has audio (iOS `speaker.wave.2`). */
    val Speaker: ImageVector by lazy {
        icon(
            "Speaker",
            "M3,9v6h4l5,5V4L7,9H3zM16.5,12c0,-1.77 -1.02,-3.29 -2.5,-4.03v8.05" +
                "c1.48,-0.73 2.5,-2.25 2.5,-4.02zM14,3.23v2.06c2.89,0.86 5,3.54 5,6.71" +
                "s-2.11,5.85 -5,6.71v2.06c4.01,-0.91 7,-4.49 7,-8.77s-2.99,-7.86 -7,-8.77z",
        )
    }

    /** A clock face — a duration (iOS `clock`). */
    val Clock: ImageVector by lazy {
        icon(
            "Clock",
            "M11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10C17.52,22 22,17.52 22,12S17.52,2 11.99,2z" +
                "M12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8z" +
                "M12.5,7H11v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z",
        )
    }

    /** An arrow down onto a line — "Download". */
    val Download: ImageVector by lazy {
        icon("Download", "M19,9h-4V3H9v6H5l7,7 7,-7zM5,18v2h14v-2H5z")
    }

    /** A circled cross — "Remove download" (iOS `xmark.circle`). */
    val RemoveDownload: ImageVector by lazy {
        icon(
            "RemoveDownload",
            "M14.59,8L12,10.59 9.41,8 8,9.41 10.59,12 8,14.59 9.41,16 12,13.41 14.59,16 16,14.59 " +
                "13.41,12 16,9.41 14.59,8zM12,2C6.47,2 2,6.47 2,12s4.47,10 10,10 10,-4.47 10,-10" +
                "S17.53,2 12,2zM12,20c-4.41,0 -8,-3.59 -8,-8s3.59,-8 8,-8 8,3.59 8,8 -3.59,8 -8,8z",
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
