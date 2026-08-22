//! The one pass every piece of transcript text goes through before anyone sees
//! it: Simplified→Traditional, then the user's phrase dictionary.
//!
//! Order matters. OpenCC runs first so a variant recorded in Traditional still
//! matches text the STT returned in Simplified; the dictionary then rewrites the
//! terms the model got wrong no matter which script it used.

import { toTraditional } from "./zhConvert";
import { applyReplacements } from "./dictionary";

/** Convert to Traditional Chinese and apply the phrase dictionary. */
export async function normalizeTranscriptText(text: string): Promise<string> {
  return applyReplacements(await toTraditional(text));
}
