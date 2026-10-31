import { translate } from "../../i18n/messages";
import type { AppLanguage } from "../types";

/**
 * The name a timed draft gets until the user writes one: "10/31（週六） 14:00
 * 會議" / "Meeting Sat, Oct 31, 2:00 PM". The title stays an ordinary field —
 * prefilled with this, editable, and allowed to be empty.
 */
export function autoMeetingTitle(meetingAt: number, language: AppLanguage): string {
  const time =
    language === "en"
      ? new Date(meetingAt).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })
      : new Date(meetingAt).toLocaleString("zh-TW", {
          month: "numeric",
          day: "numeric",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
  return translate(language, "draft.autoTitle", { time });
}

/**
 * The title after the meeting time moved from `prevAt` to `nextAt`: a title
 * still holding the old time's auto name follows the time; a blank one is
 * filled when a time is first set; anything the user wrote stays. Pure.
 */
export function retitleForTime(
  title: string,
  prevAt: number | null,
  nextAt: number | null,
  language: AppLanguage,
): string {
  const wasAuto = prevAt != null && title === autoMeetingTitle(prevAt, language);
  if (nextAt == null) return wasAuto ? "" : title;
  if (wasAuto || (prevAt == null && !title.trim())) return autoMeetingTitle(nextAt, language);
  return title;
}
