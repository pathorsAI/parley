// GENERATED from shared/prompts/filing.json by scripts/gen-filing-prompt.mjs — do not edit.
package com.pathors.parley.kit

/** The shared title + filing prompt. See shared/prompts/filing.json. */
object FilingPrompt {
    const val MODEL: String = "parley-fast"
    const val TEMPERATURE: Double = 0.2
    const val MAX_TOKENS: Int = 512
    const val MAX_TITLE_CHARACTERS: Int = 80
    const val SIMPLIFIED_ONLY_CHARS: String = "说时对开门问间东发经过还进远运动会员实处体验声记忆费术语议论证据坚决卖买风飞马鸟龙单双击战胜负责务际线联网络继续读书写听讲词汇报诉应该脑头们个从来没错误导师长辈坛贴质价钱财产业习惯题标号码现场适当选择优点败义愤骂汉简传输车电话张欢乐学觉视观见亲让认识请谢谁边铁银钟页顺须顾预领频颜类显"
    const val MAX_TRANSCRIPT_CHARACTERS: Int = 24000
    const val HEAD_SHARE_NUMERATOR: Int = 2
    const val HEAD_SHARE_DENOMINATOR: Int = 3
    const val ELISION_MARKER: String = "\n\n[… transcript trimmed …]\n\n"
    const val RULES: String = "Given a finished meeting transcript, decide what the recording should be CALLED and where it should be FILED. Every door into a recording names it badly — a live recording arrives as a date stamp (\"即時會議 · <date>\", \"會議 <date>\", \"Meeting <date>\") and an upload arrives as its file name — so this is usually the first honest title the recording gets.\n\nTITLE\n- Say what the meeting was ABOUT and, where it is clear, WITH WHOM: a company or a person plus the topic or the decision reached.\n- No date and no time. The library card already shows those, so spending the title on them wastes the only line the user reads.\n- No filler as the subject: \"meeting\", \"recording\", \"call\", \"會議\", \"討論\" and the like describe every recording in the library and therefore identify none of them. A title that would fit any meeting is a failed title.\n- Keep it short — roughly 10-24 characters of CJK, or about 4-8 English words.\n- If the current title is already specific, accurate and in the required language, return it UNCHANGED. Churn for its own sake makes the library harder to trust, not easier. A date-stamp or file-name title is never already good.\n\nFOLDERS\n- The user's existing folders are listed below. Strongly prefer them. One folder is typically one customer/company or one ongoing workstream, so ask which of those this conversation belongs to.\n- Return 2-3 candidates ordered best-first. If only one is genuinely defensible, return one — a padded list is worse than a short one.\n- Copy an existing folder's name EXACTLY (character for character) when you mean that folder, and set isNew to false.\n- AT MOST ONE candidate may be a folder that does not exist yet (isNew: true), and only when no existing folder honestly fits. A new folder per meeting would grow the registry faster than the user can prune it.\n- reason is ONE short clause saying why the folder fits — it is shown as a tooltip, not read as prose."
    const val LANGUAGE_INSTRUCTION_ZH_TW: String = "\n\nWrite the title and every reason in Traditional Chinese (繁體中文), regardless of the language spoken in the transcript. Proper names (people, companies, products) stay as they are spoken."
    const val LANGUAGE_INSTRUCTION_EN: String = "\n\nWrite the title and every reason in English, regardless of the language spoken in the transcript. Proper names (people, companies, products) stay as they are spoken."
    const val JSON_INSTRUCTION: String = "\n\nReturn your answer strictly as a single JSON object and nothing else — no preamble, no explanation, no code fences. Use these property names EXACTLY (verbatim): {\"title\": string, \"folders\": [{\"name\": string, \"isNew\": boolean, \"reason\": string}]}."
    const val MEETING_CONTEXT_PREFIX: String = "Meeting context: "
    const val CURRENT_TITLE_PREFIX: String = "The recording is currently called: "
    const val UNTITLED: String = "(untitled)"
    const val FOLDERS_HEADER: String = "The user's existing folders:"
    const val NO_FOLDERS: String = "The user has NO folders yet, so every suggestion would have to be created — return exactly ONE folder, with isNew: true."
    const val TRANSCRIPT_HEADER: String = "Transcript:"
}
