import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LanguageModelUsage } from "ai";
import { isTauri } from "../tauriEvents";
import { llmCostUsd, sttCostUsd } from "./pricing";
import type { Settings } from "../types";

/**
 * One usage record. Written as a single JSON line to `usage.jsonl` by the Rust
 * `append_usage_event` command. Cost is computed up-front (see pricing.ts) and
 * frozen into the record, so historical totals don't shift when prices change.
 */
export interface UsageEvent {
  /** Epoch milliseconds. */
  ts: number;
  kind: "llm" | "stt";
  /** What triggered it: "ask" | "eval" | "todo" (llm) or "transcription" (stt). */
  category: string;
  /** Provider id (e.g. "anthropic", "soniox"). */
  provider: string;
  /** Model id (llm), or the STT model / "" when not meaningful. */
  model: string;
  // LLM usage:
  inputTokens?: number;
  outputTokens?: number;
  /** Cache-READ input tokens (a subset of inputTokens), billed at the cache rate. */
  cachedInputTokens?: number;
  /** Cache-WRITE (cache-creation) input tokens, billed at the write rate. */
  cacheWriteTokens?: number;
  // STT usage:
  /** Seconds of audio streamed to the provider. */
  seconds?: number;
  /** Estimated cost in USD, computed at record time from the pricing table. */
  costUsd: number;
}

/** Append one usage record. No-op outside the Tauri shell. */
export async function recordUsage(event: Omit<UsageEvent, "ts">): Promise<void> {
  if (!isTauri()) return;
  const full: UsageEvent = { ts: Date.now(), ...event };
  try {
    await invoke("append_usage_event", { line: JSON.stringify(full) });
  } catch (e) {
    // Usage logging is best-effort; never break a call because logging failed.
    console.warn("[usage] failed to record event", e);
  }
}

/**
 * Record one LLM call: resolves the active provider/model, computes cost, and
 * appends the event. `kind` is the model slot used for the call ("eval" or
 * "ask"); `category` is what the call was for ("eval" | "todo" | "ask").
 */
export async function recordLlmUsage(
  settings: Settings,
  kind: "ask" | "eval",
  category: string,
  usage: LanguageModelUsage | undefined
): Promise<void> {
  if (!usage) return;
  const provider = settings.provider;
  const model = settings.models[provider][kind];

  // Split input into non-cached / cache-read / cache-write, preferring the
  // SDK's normalized detail fields and falling back to arithmetic.
  const totalInput = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const d = usage.inputTokenDetails;
  const cacheReadInput = d?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWriteInput = d?.cacheWriteTokens ?? 0;
  const noCacheInput = d?.noCacheTokens ?? Math.max(0, totalInput - cacheReadInput - cacheWriteInput);

  const costUsd = llmCostUsd(provider, model, {
    noCacheInput,
    cacheReadInput,
    cacheWriteInput,
    output,
    totalInput,
  });

  await recordUsage({
    kind: "llm",
    category,
    provider,
    model,
    inputTokens: totalInput,
    outputTokens: output,
    cachedInputTokens: cacheReadInput,
    cacheWriteTokens: cacheWriteInput,
    costUsd,
  });
}

/**
 * Subscribe to `usage://stt` events emitted by the Rust backend at the end of
 * each transcription session, and log the audio cost. No-op outside Tauri.
 */
export async function listenForSttUsage(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ provider: string; source: string; seconds: number }>("usage://stt", (e) => {
    const { provider, seconds } = e.payload;
    if (!seconds || seconds <= 0) return;
    void recordUsage({
      kind: "stt",
      category: "transcription",
      provider,
      model: "",
      seconds,
      costUsd: sttCostUsd(provider, seconds),
    });
  });
}

/** Read and parse the whole usage log (newest last). Empty outside Tauri. */
export async function readUsageEvents(): Promise<UsageEvent[]> {
  if (!isTauri()) return [];
  try {
    const raw = await invoke<string>("read_usage_events");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageEvent];
        } catch {
          return []; // skip a corrupt line rather than dropping the whole log
        }
      });
  } catch (e) {
    console.warn("[usage] failed to read log", e);
    return [];
  }
}
