package com.pathors.parley.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The cloud's OpenAI-compatible chat endpoint (`POST v1/chat/completions`), as
 * the phone's one-shot LLM passes use it. iOS `ParleyKit/CloudChat.swift`.
 *
 * The transport is the app's `CloudClient` (it owns the bearer token and the
 * 401 discipline); this module only knows the wire shapes, so the passes built
 * on it can be tested against a fake without a server.
 */
interface ChatCompletions {
    /**
     * Send one request body to `v1/chat/completions` and return the response
     * body. Throws on transport or HTTP failure.
     */
    suspend fun chatCompletion(requestJson: String): String
}

object CloudChat {
    /** The cloud's OpenAI-compatible chat endpoint, relative to the API base. */
    const val PATH = "v1/chat/completions"

    @Serializable
    data class Message(val role: String, val content: String)

    /**
     * The request, in the OpenAI shape: `max_tokens` is snake_case on the wire.
     * Deliberately no `response_format` — see [FilingSuggester.jsonInstruction].
     */
    @Serializable
    data class Request(
        val model: String,
        val temperature: Double,
        @SerialName("max_tokens") val maxTokens: Int,
        val messages: List<Message>,
    )

    @Serializable
    private data class Response(val choices: List<Choice> = emptyList())

    @Serializable
    private data class Choice(val message: ChoiceMessage? = null)

    @Serializable
    private data class ChoiceMessage(val content: String? = null)

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun encode(request: Request): String = json.encodeToString(Request.serializer(), request)

    /**
     * The assistant's text, or null when the response was unparsable or
     * choiceless. Callers treat that exactly like a network failure — keep what
     * the user already has — so there is no error to interpret here.
     */
    fun content(responseJson: String): String? =
        runCatching { json.decodeFromString(Response.serializer(), responseJson) }
            .getOrNull()
            ?.choices
            ?.firstOrNull()
            ?.message
            ?.content
}
