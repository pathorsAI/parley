package com.pathors.parley.util

import android.util.Log
import java.io.File

private const val TAG = "Files"

/**
 * Delete this file, deliberately tolerating failure.
 *
 * Every caller is on a best-effort cleanup path: dropping a temp file, clearing
 * the slot a rename is about to fill, or removing a queue entry the cloud has
 * already accepted. A refused delete leaves a stale file that the next pass
 * overwrites or ignores — it is never a reason to fail the operation in
 * progress, but it is worth a line in the log when it happens.
 *
 * Exists so the ignored `File.delete()` return value is ignored *once*, on
 * purpose, in one place.
 */
internal fun File.deleteQuietly() {
    if (!delete() && exists()) {
        Log.w(TAG, "could not delete $absolutePath")
    }
}
