package com.pathors.parley.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The live meeting's one glyph the core Material icon set does not have, drawn
 * by hand for the same reason as [LibraryIcons]: `material-icons-extended`
 * would be thousands of classes for one path.
 */
internal object MeetingIcons {

    /**
     * A bolt in a ring — "the live transcript is over", iOS's
     * `bolt.horizontal.circle` on the same line. A ring and a bolt rather than a
     * warning triangle, because the recording is fine and only the live words
     * stopped.
     */
    val TranscriptStopped: ImageVector by lazy {
        ImageVector.Builder(
            name = "TranscriptStopped",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = addPathNodes(
                // The ring: two circles, the inner one cut out by even-odd.
                "M2,12a10,10 0 1,0 20,0a10,10 0 1,0 -20,0z" +
                    "M3.8,12a8.2,8.2 0 1,0 16.4,0a8.2,8.2 0 1,0 -16.4,0z" +
                    // The bolt, inside the cut-out, so even-odd fills it again.
                    "M13,6.5L8,13h3.5l-0.7,4.5L16,11h-3.6z",
            ),
            pathFillType = PathFillType.EvenOdd,
            fill = SolidColor(Color.Black),
        ).build()
    }
}
