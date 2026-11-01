import { useStore } from "../lib/store";
import {
  personalDestination,
  type LibraryDestination,
  type OrgHandoffMode,
} from "../lib/library/destination";

/**
 * The upcoming meeting's destination as a `DestinationField` value, and what
 * committing one does — shared by every door that asks "where does this save"
 * before the recording exists (the ingest wizard, the meeting draft).
 *
 * A per-meeting org pick rides on `meetingOrgShare`, which the save path
 * already honours; the personal folder rides on `meetingFolderId`. They stay
 * two fields because a "copy" lands in both — going back to a personal
 * destination only clears the org side when this meeting had explicitly
 * chosen one, so the settings-wide auto-share default is left alone.
 */
export function useMeetingDestination() {
  const meetingFolderId = useStore((s) => s.meetingFolderId);
  const setMeetingFolder = useStore((s) => s.setMeetingFolder);
  const meetingOrgShare = useStore((s) => s.meetingOrgShare);
  const setMeetingOrgShare = useStore((s) => s.setMeetingOrgShare);

  const orgShare = typeof meetingOrgShare === "object" ? meetingOrgShare : null;
  const destination: LibraryDestination = orgShare
    ? { scope: "org", orgId: orgShare.orgId, folderId: orgShare.folderId }
    : personalDestination(meetingFolderId);

  function pickDestination(next: LibraryDestination, mode: OrgHandoffMode | null) {
    if (next.scope === "org") {
      setMeetingOrgShare({ orgId: next.orgId, folderId: next.folderId, mode: mode ?? "copy" });
      return;
    }
    setMeetingFolder(next.folderId);
    if (orgShare) setMeetingOrgShare(null);
  }

  return {
    destination,
    mode: orgShare?.mode ?? null,
    /** Nothing picked yet — the sheet may open on the last-used place. */
    fresh: meetingFolderId === null && !orgShare,
    pickDestination,
  };
}
