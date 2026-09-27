package com.pathors.parley.kit

/**
 * A heuristic drift detector, not a converter: a membership test against
 * high-frequency characters whose Traditional counterpart is a different
 * character (说/說, 时/時, 开/開…). It answers "did Simplified Chinese appear
 * here", nothing more — it cannot tell you a text is Traditional, and it is not a
 * script classifier. Over-rejecting is the safe direction: a rejected suggestion
 * just leaves the user with what they already had.
 *
 * The character set is iOS `TranscriptPolisher.simplifiedOnly`, verbatim, so the
 * two phones reject the same titles.
 */
object SimplifiedChinese {

    /**
     * Simplified-only characters. Characters that are also written this way in
     * Traditional Chinese (別, 份, 氣, 目, 內, 那…) are deliberately absent: they
     * would fire on perfectly good Traditional output.
     */
    private val simplifiedOnly: Set<Char> = (
        "说时后对开门问间东发经过还进远运动会员实处体验声记忆费术语议论证据坚决卖买风飞马鸟龙单双击战胜负责务际线联网络继续读书写听讲词汇报诉" +
            "应该脑头们几个从来没错误导师长辈坛贴质价钱财产业习惯题标号码现场适当选择优点败义愤骂" +
            "汉简传输车电话张欢乐学觉视观见亲让认识请谢谁边铁银钟页顺须顾预领频颜类显"
        ).toSet()

    fun contains(text: String): Boolean = text.any { it in simplifiedOnly }
}
