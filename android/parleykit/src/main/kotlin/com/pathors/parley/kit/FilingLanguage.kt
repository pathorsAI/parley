package com.pathors.parley.kit

/**
 * The language the filing pass writes its title and reasons in: the app's UI
 * language, never the language that happened to be spoken. The desktop forces
 * the same choice (`shared/prompts/filing.json` `languageInstruction`), so a
 * meeting held in English on a Traditional Chinese phone gets the same Chinese
 * title on every device.
 *
 * The app layer decides which one applies (it owns the Android resources that
 * say what the user is reading); this type only carries the decision into the
 * prompt, which keeps `:parleykit` free of Android context.
 */
enum class FilingLanguage(val instruction: String) {
    ZH_TW(FilingPrompt.LANGUAGE_INSTRUCTION_ZH_TW),
    EN(FilingPrompt.LANGUAGE_INSTRUCTION_EN),
    ;

    companion object {
        /**
         * The language for a BCP 47 tag: Traditional Chinese for `zh-TW`,
         * `zh-Hant` (any region), `zh-HK` and `zh-MO`; English for everything
         * else — the app ships only those two, and a Simplified Chinese phone
         * reads the app in English.
         */
        fun forTag(tag: String): FilingLanguage {
            val parts = tag.trim().replace('_', '-').split('-').map { it.lowercase() }
            if (parts.firstOrNull() != "zh") return EN
            val rest = parts.drop(1)
            if ("hans" in rest) return EN
            return if ("hant" in rest || rest.any { it in TRADITIONAL_REGIONS }) ZH_TW else EN
        }

        private val TRADITIONAL_REGIONS = setOf("tw", "hk", "mo")
    }
}
