package com.pathors.parley.feedback

/**
 * Takes out of a log line everything that must never leave the phone in a
 * report: session tokens, email addresses, and the names of files and folders
 * the user picked.
 *
 * ## What it can and cannot promise
 *
 * A scrubber can only remove what has a recognisable shape. Tokens do (a
 * `Bearer` prefix, a `token=` parameter, a long run of token alphabet), emails
 * do, and `content://` / storage paths do. **Transcript text and anything typed
 * into a field do not** — no pattern tells a sentence someone said from a
 * sentence the app wrote. So the guarantee that transcripts never reach a report
 * is made where it can be made, at the source: no call site logs segment text
 * or user input, and the diagnostics carry transcript *shape* (counts, end
 * times), never content. This pass is the second line — it catches the
 * identifiers that *do* end up in exception messages and URLs, where a call
 * site cannot reasonably control them.
 *
 * Recording and folder ids survive on purpose: a UUID identifies a row for us
 * and nothing about a person, and without it a report about "this recording"
 * cannot be matched to the recording.
 */
object LogScrubber {

    const val REDACTED = "<redacted>"
    const val EMAIL = "<email>"

    private val BEARER = Regex("""(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+""")
    /**
     * Credential-shaped query or form parameters. Not `code=`: the relay's
     * close reason is "close code=1006", and that number is exactly what a
     * report is for.
     */
    private val TOKEN_PARAM = Regex("""(?i)\b(token|session|access_token|refresh_token|api_key|password|secret)=[^&\s"']+""")
    private val EMAIL_ADDRESS = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")

    /**
     * A content URI names a user-chosen document, and many providers put the
     * file's display name — "Board meeting with Acme.m4a" — right in its path.
     * The authority is kept (it says *which* provider, which is diagnostic);
     * the path goes. It stops at a colon: SAF paths are percent-encoded, and
     * the app's own lines put ": reason" straight after a URI.
     */
    private val CONTENT_URI = Regex("""\bcontent://([A-Za-z0-9._-]+)/[^\s"')\]:]*""")

    /** Shared-storage paths carry folder and file names the user chose. */
    private val STORAGE_PATH = Regex("""/(?:storage|sdcard)/[^\s"')\]:]*""")

    private val UUID = Regex("""^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$""")

    /**
     * A long run of the token alphabet. Session tokens are 32+ characters of
     * it; ordinary words, numbers, class names and file names are not (dots
     * and slashes are outside the set, so a package name breaks into short
     * runs). UUIDs match the shape and are let through by [UUID].
     */
    private val OPAQUE = Regex("""[A-Za-z0-9_-]{32,}""")

    fun scrub(text: String): String {
        if (text.isEmpty()) return text
        var out = BEARER.replace(text) { "Bearer $REDACTED" }
        out = TOKEN_PARAM.replace(out) { "${it.groupValues[1]}=$REDACTED" }
        out = EMAIL_ADDRESS.replace(out, EMAIL)
        out = CONTENT_URI.replace(out) { "content://${it.groupValues[1]}/$REDACTED" }
        out = STORAGE_PATH.replace(out) { "/storage/$REDACTED" }
        out = OPAQUE.replace(out) { match -> if (UUID.matches(match.value)) match.value else REDACTED }
        return out
    }
}
