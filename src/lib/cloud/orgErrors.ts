import { CloudError } from "./client";
import type { TranslationKey } from "../../i18n/messages";

/**
 * Turn a cloud failure into a human, localized reason. better-auth returns a
 * machine `code` on a 4xx; map the ones a user can act on and fall back to the
 * backend's own message for the rest.
 */
export function orgErrMsg(t: (key: TranslationKey) => string, e: unknown): string {
  const code = e instanceof CloudError ? e.code : null;
  switch (code) {
    case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
      return t("settings.org.errAlreadyMember");
    case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
      return t("settings.org.errAlreadyInvited");
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION":
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION":
      return t("settings.org.errNotAllowed");
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER":
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER":
      return t("settings.org.leaveOnlyOwner");
    case "MEMBER_NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
      return t("settings.org.errOrgGone");
    case "INVITATION_NOT_FOUND":
      return t("settings.org.errInvitationGone");
    case "INVALID_EMAIL":
      return t("settings.org.errInvalidEmail");
    default:
      return e instanceof Error ? e.message : String(e);
  }
}
