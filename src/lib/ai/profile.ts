import type { Settings } from "../types";

/**
 * A short preamble describing who "ME" is, injected into every meeting prompt
 * (ask / evaluations / todos). Helps the model recognize when the user is
 * speaking or addressed by name — especially under diarization, where speakers
 * arrive as numbers — and tailor guidance to their role.
 */
export function profileContext(settings: Settings): string {
  const parts: string[] = [];
  if (settings.userName.trim()) parts.push(`name: ${settings.userName.trim()}`);
  if (settings.userRole.trim()) parts.push(`role: ${settings.userRole.trim()}`);
  if (settings.userCompany.trim()) parts.push(`company: ${settings.userCompany.trim()}`);
  if (parts.length === 0) return "";
  return (
    `About ME (the person you assist) — ${parts.join(", ")}. ` +
    `Use this to spot when ME is the one speaking or being addressed, and tailor advice to their role.\n\n`
  );
}
