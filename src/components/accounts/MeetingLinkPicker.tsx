import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf } from "../../lib/accounts/store";
import { ensureCompanyFolder } from "../../lib/accounts/folders";
import { useStageSet } from "../../lib/accounts/useStageSet";
import { persistEntryLink } from "../../lib/history/history";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import { Combobox } from "@/components/ui/combobox";

/**
 * The company/thread/attendees picker — the ONE control that edits the store's
 * meeting link, shared by the mid-call amendment (MeetingLinkSection) and the
 * study report's after-the-fact link bar. Extracted so a third surface never
 * re-implements the combobox rows and drifts.
 */
export function MeetingLinkPicker() {
  const { t } = useI18n();
  const acc = useAccounts();
  const stageSet = useStageSet();
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const setMeetingLink = useStore((s) => s.setMeetingLink);

  const companies = acc.companies.filter((c) => !c.archived);
  const company = companies.find((c) => c.id === companyId) ?? null;
  const persons = company ? personsOf(acc, company.id) : [];
  const threads = company ? threadsOf(acc, company.id).filter((x) => x.status === "active") : [];

  const apply = (link: {
    companyId: string | null;
    threadId: string | null;
    attendeeIds: string[];
  }) => {
    setMeetingLink(link);
    // A LOADED saved entry gets the new link written back right away (study's
    // after-the-fact linking) — live/pre-flight have no entry yet, and their
    // save paths snapshot these fields; persistEntryLink no-ops there.
    void persistEntryLink().catch((e) =>
      log.warn("accounts: meeting-link persist failed", { error: String(e) })
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="w-14 shrink-0 text-xs text-muted-foreground">
          {t("accounts.link.company")}
        </label>
        <Combobox
          size="sm"
          value={companyId ?? ""}
          groups={[
            {
              options: [
                { value: "", label: t("accounts.link.none") },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ],
            },
          ]}
          onChange={(v) => apply({ companyId: v || null, threadId: null, attendeeIds: [] })}
          onCreate={(name) => {
            const created = acc.addCompany({ name });
            ensureCompanyFolder(created);
            apply({ companyId: created.id, threadId: null, attendeeIds: [] });
          }}
          createLabel={(name) => t("owner.create", { name })}
          placeholder={t("accounts.link.none")}
          searchPlaceholder={t("preflight.search")}
          emptyText={t("preflight.noMatch")}
        />
      </div>

      {company && threads.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="w-14 shrink-0 text-xs text-muted-foreground">
            {t("accounts.link.thread")}
          </label>
          <Combobox
            size="sm"
            value={threadId ?? ""}
            groups={[
              {
                options: [
                  { value: "", label: t("accounts.link.none") },
                  ...threads.map((x) => ({
                    value: x.id,
                    label: x.name,
                    hint: x.stage ? (stageSet.names[x.stage] ?? x.stage) : undefined,
                  })),
                ],
              },
            ]}
            onChange={(v) => apply({ companyId, threadId: v || null, attendeeIds })}
            onCreate={(name) => {
              const created = acc.addThread({ companyId: company.id, kind: "sales", name });
              apply({ companyId, threadId: created.id, attendeeIds });
            }}
            createLabel={(name) => t("owner.create", { name })}
            placeholder={t("accounts.link.none")}
            searchPlaceholder={t("preflight.search")}
            emptyText={t("preflight.noMatch")}
          />
        </div>
      )}

      {company && persons.length > 0 && (
        <div className="flex items-start gap-2">
          <label className="w-14 shrink-0 pt-1 text-xs text-muted-foreground">
            {t("accounts.link.attendees")}
          </label>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {persons.map((p) => {
              const on = attendeeIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    apply({
                      companyId,
                      threadId,
                      attendeeIds: on
                        ? attendeeIds.filter((x) => x !== p.id)
                        : [...attendeeIds, p.id],
                    })
                  }
                  className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    on
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
