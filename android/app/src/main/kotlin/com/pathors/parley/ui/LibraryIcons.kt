package com.pathors.parley.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The glyphs the library needs and the core icon set lacks: folders and
 * organizations, where a recording came from (live, uploaded), and the
 * row's on-phone mark.
 *
 * The app depends on the core Material icon set only, which has no folder, no
 * tray, no group, no waveform and no upload mark. Pulling in
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
     * Vertical bars of a level meter — a recording made live (iOS `waveform`,
     * Material `graphic_eq`).
     */
    val Waveform: ImageVector by lazy {
        icon(
            "Waveform",
            "M7,18h2V6H7v12zM11,22h2V2h-2v20zM3,14h2v-4H3v4zM15,18h2V6h-2v12zM19,10v4h2v-4h-2z",
        )
    }

    /**
     * A document with an arrow going up out of it — a recording that came in as
     * an uploaded file, and the Library's Import button (iOS `arrow.up.doc`,
     * Material `upload_file`). One glyph for both, so the button and what it
     * makes look alike.
     */
    val UploadDoc: ImageVector by lazy {
        icon(
            "UploadDoc",
            "M14,2H6c-1.1,0 -1.99,0.9 -1.99,2L4,20c0,1.1 0.89,2 1.99,2H18c1.1,0 2,-0.9 2,-2V8l-6,-6z" +
                "M18,20H6V4h7v5h5v11zM8,15.01l1.41,1.41L11,14.84V19h2v-4.16l1.59,1.59L16,15.01 12.01,11z",
        )
    }

    /**
     * A page with lines of text — the record screen's "view the meeting
     * draft" (Material `description`, outlined).
     */
    val Description: ImageVector by lazy {
        icon(
            "Description",
            "M8,16h8v2H8zM8,12h8v2H8zM14,2H6c-1.1,0 -1.99,0.9 -1.99,2L4,20c0,1.1 0.89,2 1.99,2H18" +
                "c1.1,0 2,-0.9 2,-2V8l-6,-6zM18,20H6V4h7v5h5v11z",
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
