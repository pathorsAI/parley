package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The chat endpoint's response shape, and the ways it can come back useless. */
class CloudChatTest {

    @Test
    fun `reads the first choice's content`() {
        assertEquals(
            "hello",
            CloudChat.content("""{"id":"x","choices":[{"message":{"role":"assistant","content":"hello"}},{"message":{"content":"no"}}]}"""),
        )
    }

    @Test
    fun `a choiceless or unparsable response is null`() {
        assertNull(CloudChat.content("""{"choices":[]}"""))
        assertNull(CloudChat.content("""{"choices":[{"message":{}}]}"""))
        assertNull(CloudChat.content("not json"))
    }

    @Test
    fun `detects simplified drift characters only`() {
        assertEquals(true, SimplifiedChinese.contains("我们说"))
        assertEquals(false, SimplifiedChinese.contains("我們說 hello 別份氣"))
    }
}
