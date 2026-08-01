import { useMemo, useState } from "react";
import { FolderClosed } from "lucide-react";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf } from "../../lib/accounts/store";
import { ensureCompanyFolder } from "../../lib/accounts/folders";
import { stageFor } from "../../lib/accounts/currentStage";
import { useScenarioSet } from "../../lib/accounts/useStageSet";
import { applyScenario } from "../../lib/meeting/scenario";
import { resolveMeetingSave } from "../../lib/history/history";
import { listLocalFolders } from "../../lib/history/folders";
import { useI18n } from "../../i18n";
import type { MeetingType } from "../../lib/types";
import { Combobox, type ComboGroup } from "@/components/ui/combobox";
import { SaveDestinationPicker } from "../SaveDestinationPicker";
import { Column, Field, InlineCreate, SectionTitle } from "./bits";

/**
 * Pre-flight column ①: WHO this call is with.
 *
 * The save destination lives here as a RESULT, not a second control. Linking a
 * company decides the folder (every company owns one — see accounts/folders);
 * "save somewhere else" is an explicit opt-out that sets a per-meeting
 * override. Before this screen, a titlebar folder chip and a buried company
 * dropdown both claimed to decide where a recording landed and the company
 * link silently won — meetings filed themselves under the wrong customer with
 * nothing on screen to explain it.
 */
export function SubjectPanel() {
  const { t } = useI18n();
  const acc = useAccounts();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.meetingType);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const meetingStage = useStore((s) => s.meetingStage);
  const setMeetingStage = useStore((s) => s.setMeetingStage);
  const setMeetingLink = useStore((s) => s.setMeetingLink);
  const saveOverride = useStore((s) => s.meetingSaveOverride);
  const setSaveOverride = useStore((s) => s.setMeetingSaveOverride);
  const syncEnabled = useStore((s) => s.settings.syncEnabled);
  const defaultSave = useStore((s) => s.settings.defaultSaveLocation);

  // Which inline-create row is open (at most one — each takes over its field).
  const [creating, setCreating] = useState<"company" | "thread" | "person" | null>(null);

  // Only "general" has no board and no customer side (design D12).
  const scenario = scenarios.byId[meetingType] ?? null;
  const companies = acc.companies.filter((c) => !c.archived);
  const company = companies.find((c) => c.id === companyId) ?? null;
  const threads = company ? threadsOf(acc, company.id).filter((x) => x.status === "active") : [];
  const persons = company ? personsOf(acc, company.id) : [];

  const stageOptions: ComboGroup[] = useMemo(
    () =>
      scenario
        ? [{ options: scenario.order.map((s) => ({ value: s, label: scenario.names[s] ?? s })) }]
        : [],
    [scenario]
  );
  const thread = threads.find((x) => x.id === threadId) ?? null;
  // The picker must show the stage the board will actually run — same resolver.
  const stage = scenario ? stageFor(scenario, meetingStage, thread) : "";

  // What the save will actually do, recomputed from the same function the save
  // path calls. Reading `useAccounts()`/store above keeps this reactive.
  const save = resolveMeetingSave();
  const folderName =
    save.folderId
      ? (listLocalFolders().find((f) => f.id === save.folderId)?.name ??
        t("settings.account.defaultSave.root"))
      : t("settings.account.defaultSave.root");

  function createCompany(name: string) {
    const created = acc.addCompany({ name });
    ensureCompanyFolder(created);
    setMeetingLink({ companyId: created.id, threadId: null, attendeeIds: [] });
  }

  function createThread(name: string) {
    if (!company) return;
    const created = acc.addThread({ companyId: company.id, kind: "sales", name });
    setMeetingLink({ companyId: company.id, threadId: created.id, attendeeIds });
  }

  function createPerson(name: string) {
    if (!company) return;
    const created = acc.addPerson({ companyId: company.id, name });
    setMeetingLink({ companyId: company.id, threadId, attendeeIds: [...attendeeIds, created.id] });
  }

  return (
    <Column step="①" title={t("preflight.subject.title")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Field label={t("preflight.field.scenario")}>
            <Combobox
              size="sm"
              value={scenario ? meetingType : "general"}
              groups={[
                {
                  options: [
                    { value: "general", label: t("board.type.general") },
                    ...scenarios.list.map((s) => ({
                      value: s.id,
                      label: `${s.icon} ${s.name}`,
                    })),
                  ],
                },
              ]}
              onChange={(v) => applyScenario(v as MeetingType, scenarios)}
              placeholder={t("board.type.general")}
              searchPlaceholder={t("preflight.search")}
              emptyText={t("preflight.noMatch")}
            />
          </Field>

          {scenario && (
            <>
              <Field label={t("accounts.link.company")}>
                {creating !== "company" && (
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
                    onChange={(v) =>
                      setMeetingLink({ companyId: v || null, threadId: null, attendeeIds: [] })
                    }
                    placeholder={t("accounts.link.none")}
                    searchPlaceholder={t("preflight.search")}
                    emptyText={t("preflight.noMatch")}
                  />
                )}
                <InlineCreate
                  label={t("preflight.newCompany")}
                  placeholder={t("preflight.newCompanyPlaceholder")}
                  confirmLabel={t("preflight.createConfirm")}
                  cancelLabel={t("accounts.cancel")}
                  open={creating === "company"}
                  onOpenChange={(o) => setCreating(o ? "company" : null)}
                  onCreate={createCompany}
                />
              </Field>

              {company && (
                <Field label={t("accounts.link.thread")}>
                  {creating !== "thread" && (
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
                              hint: x.stage ? (scenario.names[x.stage] ?? x.stage) : undefined,
                            })),
                          ],
                        },
                      ]}
                      onChange={(v) =>
                        setMeetingLink({ companyId: company.id, threadId: v || null, attendeeIds })
                      }
                      placeholder={t("accounts.link.none")}
                      searchPlaceholder={t("preflight.search")}
                      emptyText={t("preflight.noMatch")}
                    />
                  )}
                  <InlineCreate
                    label={t("preflight.newThread")}
                    placeholder={t("preflight.newThreadPlaceholder")}
                    confirmLabel={t("preflight.createConfirm")}
                    cancelLabel={t("accounts.cancel")}
                    open={creating === "thread"}
                    onOpenChange={(o) => setCreating(o ? "thread" : null)}
                    onCreate={createThread}
                  />
                </Field>
              )}

              {scenario.order.length > 1 && (
                <Field label={t("preflight.field.stage")}>
                  <Combobox
                    size="sm"
                    value={stage}
                    groups={stageOptions}
                    onChange={(v) => setMeetingStage(v)}
                    placeholder={t("preflight.field.stage")}
                    searchPlaceholder={t("preflight.search")}
                    emptyText={t("preflight.noMatch")}
                  />
                </Field>
              )}
            </>
          )}
        </div>

        {company && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>{t("accounts.link.attendees")}</SectionTitle>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {persons.map((p) => {
                const on = attendeeIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setMeetingLink({
                        companyId: company.id,
                        threadId,
                        attendeeIds: on
                          ? attendeeIds.filter((x) => x !== p.id)
                          : [...attendeeIds, p.id],
                      })
                    }
                    className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                      on
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
              <InlineCreate
                label={t("preflight.newPerson")}
                placeholder={t("preflight.newPersonPlaceholder")}
                confirmLabel={t("preflight.createConfirm")}
                cancelLabel={t("accounts.cancel")}
                open={creating === "person"}
                onOpenChange={(o) => setCreating(o ? "person" : null)}
                onCreate={createPerson}
              />
            </div>
          </div>
        )}

        {/* Where it lands — the consequence of the choices above. */}
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <SectionTitle>{t("preflight.saveTo")}</SectionTitle>
          {saveOverride ? (
            <div className="flex flex-col items-start gap-1">
              <SaveDestinationPicker
                value={saveOverride}
                syncOn={syncEnabled}
                onChange={setSaveOverride}
              />
              <button
                type="button"
                onClick={() => setSaveOverride(null)}
                className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {t("preflight.saveAuto")}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-1">
              <span className="flex items-center gap-1.5 text-sm">
                <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
                {folderName}
              </span>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {save.origin === "company"
                    ? t("preflight.saveFollowsCompany")
                    : t("preflight.saveFollowsDefault")}
                </span>
                <button
                  type="button"
                  onClick={() => setSaveOverride(defaultSave)}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  {t("preflight.saveElsewhere")}
                </button>
              </div>
            </div>
          )}
          {save.autoShare && (
            <p className="text-[11px] text-muted-foreground">{t("preflight.saveOrgCopy")}</p>
          )}
        </div>
      </div>
    </Column>
  );
}
