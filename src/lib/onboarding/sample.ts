/** Loads the bundled sample recording into the library as a real entry and
 *  returns its history id, or null when unavailable. Implemented in a
 *  parallel workstream; this stub exists so the wizard and checklist can wire
 *  their CTAs. */
export async function loadSampleRecording(): Promise<string | null> {
  return null;
}

/** Sample entries are recognised by their id prefix. */
export function isSampleEntry(entry: { id: string }): boolean {
  return entry.id.startsWith("sample-");
}
