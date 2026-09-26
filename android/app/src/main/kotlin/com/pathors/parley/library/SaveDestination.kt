package com.pathors.parley.library

/**
 * Where a finished recording goes: the personal library (optionally into one
 * of its folders), or an organization (optionally into one of its folders).
 *
 * The iOS `SaveDestination` and the desktop's "Default save location" setting,
 * with the desktop's semantics — which are the part worth knowing:
 *
 * **Choosing an organization still saves to the personal library.** The
 * recording is uploaded to the personal library exactly as always, at its
 * root, and then *shared* — a server-side copy — into the organization, into
 * [folderId] there if one was chosen. The upload path has no way to write into
 * an org directly, and a recording that only existed in a shared space would be
 * one its own author could lose by being removed from the team.
 *
 * So [folderId] means a personal folder when [orgId] is null and an org folder
 * when it is not, and the two are never both applied.
 */
data class SaveDestination(
    /** The organization to share a copy into, or null for personal only. */
    val orgId: String? = null,
    /** A folder in the personal library (personal) or in [orgId] (org). */
    val folderId: String? = null,
) {
    val isOrg: Boolean get() = orgId != null

    /** The personal folder the upload itself is filed under. Always null for an org destination. */
    val personalFolderId: String? get() = if (isOrg) null else folderId

    /** The org folder the shared copy lands in, when this is an org destination. */
    val orgFolderId: String? get() = if (isOrg) folderId else null

    /**
     * The stored form, and the same serialization the desktop and iOS pickers
     * use as their tag: `personal`, `personal:<folderId>`, `org:<orgId>`,
     * `org:<orgId>:<folderId>`. Every id involved is a UUID or a better-auth id,
     * neither of which contains a colon.
     */
    fun encode(): String = when {
        orgId != null -> if (folderId != null) "$ORG:$orgId:$folderId" else "$ORG:$orgId"
        folderId != null -> "$PERSONAL:$folderId"
        else -> PERSONAL
    }

    companion object {
        private const val PERSONAL = "personal"
        private const val ORG = "org"

        val PERSONAL_ROOT = SaveDestination()

        /**
         * The inverse of [encode]. Anything unreadable — no value yet, a value
         * from a future version — is the personal root, which is where every
         * recording went before this setting existed.
         */
        fun decode(raw: String?): SaveDestination {
            if (raw.isNullOrBlank()) return PERSONAL_ROOT
            val parts = raw.split(':', limit = 3)
            return when (parts[0]) {
                ORG -> {
                    val orgId = parts.getOrNull(1)?.takeIf { it.isNotEmpty() }
                        ?: return PERSONAL_ROOT
                    SaveDestination(orgId = orgId, folderId = parts.getOrNull(2)?.takeIf { it.isNotEmpty() })
                }
                PERSONAL -> SaveDestination(folderId = parts.getOrNull(1)?.takeIf { it.isNotEmpty() })
                else -> PERSONAL_ROOT
            }
        }
    }
}
