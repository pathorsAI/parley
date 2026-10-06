#!/usr/bin/env node
// Generate the iOS and Android copies of shared/prompts/filing.json — the ONE
// title + filing prompt every Parley client sends. Desktop imports the JSON
// directly; the phones cannot, so they get generated constants instead.
//
//   node scripts/gen-filing-prompt.mjs           write both files
//   node scripts/gen-filing-prompt.mjs --check   exit 1 if either is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "shared/prompts/filing.json";
export const TARGETS = {
  swift: "ios/ParleyKit/Sources/ParleyKit/FilingPrompt.generated.swift",
  kotlin: "android/parleykit/src/main/kotlin/com/pathors/parley/kit/FilingPrompt.kt",
};

const HEADER = `GENERATED from ${SOURCE} by scripts/gen-filing-prompt.mjs — do not edit.`;

function escapeCommon(s) {
  return s
    .replaceAll("\\", String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\r", String.raw`\r`)
    .replaceAll("\t", String.raw`\t`);
}
const swiftString = (s) => `"${escapeCommon(s)}"`;
// Kotlin string templates make a bare `$` live, so it is escaped too.
const kotlinString = (s) => `"${escapeCommon(s).replaceAll("$", String.raw`\$`)}"`;

export function renderSwift(p) {
  const str = (name, v) => `    public static let ${name} = ${swiftString(v)}`;
  const num = (name, v) => `    public static let ${name} = ${v}`;
  return `// ${HEADER}
import Foundation

/// The shared title + filing prompt. See ${SOURCE}.
public enum FilingPrompt {
${str("model", p.model)}
${num("temperature", p.temperature.toFixed(1))}
${num("maxTokens", p.maxTokens)}
${num("maxTitleCharacters", p.maxTitleCharacters)}
${str("simplifiedOnlyChars", p.simplifiedOnlyChars)}
${num("maxTranscriptCharacters", p.maxTranscriptCharacters)}
${num("headShareNumerator", p.headShareNumerator)}
${num("headShareDenominator", p.headShareDenominator)}
${str("elisionMarker", p.elisionMarker)}
${str("rules", p.rules)}
${str("languageInstructionZhTW", p.languageInstruction["zh-TW"])}
${str("languageInstructionEn", p.languageInstruction.en)}
${str("jsonInstruction", p.jsonInstruction)}
${str("meetingContextPrefix", p.meetingContextPrefix)}
${str("currentTitlePrefix", p.currentTitlePrefix)}
${str("untitled", p.untitled)}
${str("foldersHeader", p.foldersHeader)}
${str("noFolders", p.noFolders)}
${str("transcriptHeader", p.transcriptHeader)}
}
`;
}

export function renderKotlin(p) {
  const str = (name, v) => `    const val ${name}: String = ${kotlinString(v)}`;
  const int = (name, v) => `    const val ${name}: Int = ${v}`;
  return `// ${HEADER}
package com.pathors.parley.kit

/** The shared title + filing prompt. See ${SOURCE}. */
object FilingPrompt {
${str("MODEL", p.model)}
    const val TEMPERATURE: Double = ${p.temperature.toFixed(1)}
${int("MAX_TOKENS", p.maxTokens)}
${int("MAX_TITLE_CHARACTERS", p.maxTitleCharacters)}
${str("SIMPLIFIED_ONLY_CHARS", p.simplifiedOnlyChars)}
${int("MAX_TRANSCRIPT_CHARACTERS", p.maxTranscriptCharacters)}
${int("HEAD_SHARE_NUMERATOR", p.headShareNumerator)}
${int("HEAD_SHARE_DENOMINATOR", p.headShareDenominator)}
${str("ELISION_MARKER", p.elisionMarker)}
${str("RULES", p.rules)}
${str("LANGUAGE_INSTRUCTION_ZH_TW", p.languageInstruction["zh-TW"])}
${str("LANGUAGE_INSTRUCTION_EN", p.languageInstruction.en)}
${str("JSON_INSTRUCTION", p.jsonInstruction)}
${str("MEETING_CONTEXT_PREFIX", p.meetingContextPrefix)}
${str("CURRENT_TITLE_PREFIX", p.currentTitlePrefix)}
${str("UNTITLED", p.untitled)}
${str("FOLDERS_HEADER", p.foldersHeader)}
${str("NO_FOLDERS", p.noFolders)}
${str("TRANSCRIPT_HEADER", p.transcriptHeader)}
}
`;
}

export function rendered() {
  const p = JSON.parse(readFileSync(join(root, SOURCE), "utf8"));
  return { swift: renderSwift(p), kotlin: renderKotlin(p) };
}

function main() {
  const check = process.argv.includes("--check");
  const out = rendered();
  let stale = false;
  for (const [key, rel] of Object.entries(TARGETS)) {
    const path = join(root, rel);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === out[key]) continue;
    if (check) {
      console.error(`stale: ${rel} — run node scripts/gen-filing-prompt.mjs`);
      stale = true;
    } else {
      writeFileSync(path, out[key]);
      console.log(`wrote ${rel}`);
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
