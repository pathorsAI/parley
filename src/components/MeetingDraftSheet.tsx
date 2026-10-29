import { useStore } from "../lib/store";

/**
 * The meeting draft ("新增會議草稿"): the per-meeting prep — context, folder,
 * agenda — filled in before recording, opened from the title bar and the home
 * screen via `setDraftOpen(true)`. Recording then starts with it.
 */
export function MeetingDraftSheet() {
  const open = useStore((s) => s.draftOpen);
  if (!open) return null;
  return null;
}
