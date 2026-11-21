package com.pathors.parley.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The glyphs the onboarding wizard needs and the core icon set lacks — the
 * stand-ins for the SF Symbols iOS draws (`globe`, `cloud`, `laptopcomputer`,
 * `mic`, `stop.fill`, `powerplug`…). Material Symbols paths (Apache 2.0), on
 * the same 24dp grid as the core icons, for the reason [LibraryIcons] gives.
 */
internal object OnboardingIcons {

    /** `globe` — the language button. */
    val Globe: ImageVector by lazy {
        icon(
            "Globe",
            "M11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10C17.52,22 22,17.52 22,12S17.52,2 11.99,2z" +
                "M18.92,8h-2.95c-0.32,-1.25 -0.78,-2.45 -1.38,-3.56 1.84,0.63 3.37,1.91 4.33,3.56z" +
                "M12,4.04c0.83,1.2 1.48,2.53 1.91,3.96h-3.82c0.43,-1.43 1.08,-2.76 1.91,-3.96z" +
                "M4.26,14C4.1,13.36 4,12.69 4,12s0.1,-1.36 0.26,-2h3.38c-0.08,0.66 -0.14,1.32 -0.14,2 " +
                "0,0.68 0.06,1.34 0.14,2L4.26,14z" +
                "M5.08,16h2.95c0.32,1.25 0.78,2.45 1.38,3.56 -1.84,-0.63 -3.37,-1.9 -4.33,-3.56z" +
                "M8.03,8L5.08,8c0.96,-1.66 2.49,-2.93 4.33,-3.56C8.81,5.55 8.35,6.75 8.03,8z" +
                "M12,19.96c-0.83,-1.2 -1.48,-2.53 -1.91,-3.96h3.82c-0.43,1.43 -1.08,2.76 -1.91,3.96z" +
                "M14.34,14L9.66,14c-0.09,-0.66 -0.16,-1.32 -0.16,-2 0,-0.68 0.07,-1.35 0.16,-2h4.68" +
                "c0.09,0.65 0.16,1.32 0.16,2 0,0.68 -0.07,1.34 -0.16,2z" +
                "M14.59,19.56c0.6,-1.11 1.06,-2.31 1.38,-3.56h2.95c-0.96,1.65 -2.49,2.93 -4.33,3.56z" +
                "M16.36,14c0.08,-0.66 0.14,-1.32 0.14,-2 0,-0.68 -0.06,-1.34 -0.14,-2h3.38" +
                "c0.16,0.64 0.26,1.31 0.26,2s-0.1,1.36 -0.26,2h-3.38z",
        )
    }

    /** `cloud` — the Cloud card's pill. */
    val Cloud: ImageVector by lazy {
        icon(
            "Cloud",
            "M19.35,10.04C18.67,6.59 15.64,4 12,4 9.11,4 6.6,5.64 5.35,8.04 2.34,8.36 0,10.91 0,14" +
                "c0,3.31 2.69,6 6,6h13c2.76,0 5,-2.24 5,-5 0,-2.64 -2.05,-4.78 -4.65,-4.96z" +
                "M19,18H6c-2.21,0 -4,-1.79 -4,-4s1.79,-4 4,-4h0.71C7.37,7.69 9.48,6 12,6" +
                "c3.04,0 5.5,2.46 5.5,5.5v0.5H19c1.66,0 3,1.34 3,3s-1.34,3 -3,3z",
        )
    }

    /** `laptopcomputer` — the Local card. */
    val Laptop: ImageVector by lazy {
        icon(
            "Laptop",
            "M20,18c1.1,0 1.99,-0.9 1.99,-2L22,6c0,-1.1 -0.9,-2 -2,-2H4c-1.1,0 -2,0.9 -2,2v10" +
                "c0,1.1 0.9,2 2,2H0v2h24v-2h-4zM4,6h16v10H4V6z",
        )
    }

    /** `mic` — the permission row and the test button at rest. */
    val Mic: ImageVector by lazy {
        icon(
            "Mic",
            "M12,14c1.66,0 2.99,-1.34 2.99,-3L15,5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6" +
                "c0,1.66 1.34,3 3,3zM10.8,4.9c0,-0.66 0.54,-1.2 1.2,-1.2 0.66,0 1.2,0.54 1.2,1.2" +
                "l-0.01,6.2c0,0.66 -0.53,1.2 -1.19,1.2 -0.66,0 -1.2,-0.54 -1.2,-1.2L10.8,4.9z" +
                "M17.3,11c0,3 -2.54,5.1 -5.3,5.1S6.7,14 6.7,11H5c0,3.41 2.72,6.23 6,6.72V21h2v-3.28" +
                "c3.28,-0.48 6,-3.3 6,-6.72h-1.7z",
        )
    }

    /** `stop.fill` — the test button while listening. */
    val Stop: ImageVector by lazy { icon("Stop", "M6,6h12v12H6z") }

    /** `bell` — the notifications row (Android 13 and up). */
    val Bell: ImageVector by lazy {
        icon(
            "Bell",
            "M12,22c1.1,0 2,-0.9 2,-2h-4c0,1.1 0.89,2 2,2zM18,16v-5c0,-3.07 -1.64,-5.64 -4.5,-6.32V4" +
                "c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68C7.63,5.36 6,7.92 6,11v5l-2,2v1" +
                "h16v-1l-2,-2zM16,17H8v-6c0,-2.48 1.51,-4.5 4,-4.5s4,2.02 4,4.5v6z",
        )
    }

    /** `powerplug` — the MCP plug on the demo's recording page. */
    val Plug: ImageVector by lazy {
        icon(
            "Plug",
            "M16.01,7L16,3h-2v4h-4V3H8v4h-0.01C7,6.99 6,7.99 6,8.99v5.49L9.5,18v3h5v-3" +
                "l3.5,-3.51v-5.5c0,-1 -1,-2 -1.99,-1.99z",
        )
    }

    /** `rectangle.portrait.and.arrow.right` — the sign-in button. */
    val SignIn: ImageVector by lazy {
        icon(
            "SignIn",
            "M11,7L9.6,8.4l2.6,2.6H2v2h10.2l-2.6,2.6L11,17l5,-5L11,7z" +
                "M20,19h-8v2h8c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2h-8v2h8V19z",
        )
    }

    /** `record.circle` — the demo's Record tab. */
    val RecordTab: ImageVector by lazy {
        icon(
            "RecordTab",
            "M12,7c-2.76,0 -5,2.24 -5,5s2.24,5 5,5 5,-2.24 5,-5 -2.24,-5 -5,-5z" +
                "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z" +
                "M12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8z",
        )
    }

    /** `rectangle.stack` — the demo's Library tab. */
    val LibraryTab: ImageVector by lazy {
        icon(
            "LibraryTab",
            "M20,13H3c-0.55,0 -1,0.45 -1,1v6c0,0.55 0.45,1 1,1h17c0.55,0 1,-0.45 1,-1v-6" +
                "c0,-0.55 -0.45,-1 -1,-1zM20,3H3c-0.55,0 -1,0.45 -1,1v6c0,0.55 0.45,1 1,1h17" +
                "c0.55,0 1,-0.45 1,-1V4c0,-0.55 -0.45,-1 -1,-1z",
        )
    }

    /** `circle` — an open action item. */
    val Circle: ImageVector by lazy {
        icon(
            "Circle",
            "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z" +
                "M12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8z",
        )
    }

    /** `exclamationmark.circle` — the microphone check's warnings. */
    val Alert: ImageVector by lazy {
        icon(
            "Alert",
            "M11,15h2v2h-2zM11,7h2v6h-2zM11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10" +
                "C17.52,22 22,17.52 22,12S17.52,2 11.99,2zM12,20c-4.42,0 -8,-3.58 -8,-8" +
                "s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8z",
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
