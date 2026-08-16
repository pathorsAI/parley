import { useMemo } from "react";
import { useStore } from "../../lib/store";
import { useScenarioSet } from "../../lib/scenarios/useStageSet";
import { stageFor } from "../../lib/scenarios/currentStage";
import { applyScenario } from "../../lib/meeting/scenario";
import { resolveMeetingSave } from "../../lib/history/history";
import { CLOUD_ENABLED } from "../../lib/flags";
import { useI18n } from "../../i18n";
import type { MeetingType } from "../../lib/types";
import { Combobox, type ComboGroup } from "@/components/ui/combobox";
import { FolderPicker } from "../FolderPicker";
import { OrgSharePicker } from "../OrgSharePicker";
import { Column, Field, SectionTitle } from "./bits";

/**
 * Pre-flight column ①: WHAT this call is and WHERE it will be filed.
 *
 * One customer, one folder: picking the folder here is picking the customer,
 * and it is the same folder the left tree lists the call under afterwards. The
 * only other save decision is whether an org gets a shared copy, which is
 * independent of the folder.
 */
export function SubjectPanel() {
  const { t } = useI18n();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.meetingType);
  const folderId = useStore((s) => s.meetingFolderId);
  const setMeetingFolder = useStore((s) => s.setMeetingFolder);
  const meetingStage = useStore((s) => s.meetingStage);
  const setMeetingStage = useStore((s) => s.setMeetingStage);
  const orgShare = useStore((s) => s.meetingOrgShare);
  const setOrgShare = useStore((s) => s.setMeetingOrgShare);
  const signedIn = useStore((s) => !!s.cloudAuth);
  const syncEnabled = useStore((s) => s.settings.syncEnabled);
  const defaultSave = useStore((s) => s.settings.defaultSaveLocation);

  // Only "general" has no board and no stage row (design D12).
  const scenario = scenarios.byId[meetingType] ?? null;

  const stageOptions: ComboGroup[] = useMemo(
    () =>
      scenario
        ? [{ options: scenario.order.map((s) => ({ value: s, label: scenario.names[s] ?? s })) }]
        : [],
    [scenario]
  );
  // The picker must show the stage the board will actually run — same resolver.
  const stage = scenario ? stageFor(scenario, meetingStage) : "";

  // What the save will actually do, recomputed from the same function the save
  // path calls. Reading the store above keeps this reactive.
  const save = resolveMeetingSave();

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
                    // Name only: Combobox labels are plain strings it also
                    // searches over, so there is nowhere to hang an icon
                    // component — and the name alone reads fine here.
                    ...scenarios.list.map((s) => ({ value: s.id, label: s.name })),
                  ],
                },
              ]}
              onChange={(v) => applyScenario(v as MeetingType, scenarios)}
              placeholder={t("board.type.general")}
              searchPlaceholder={t("preflight.search")}
              emptyText={t("preflight.noMatch")}
            />
          </Field>

          {scenario && scenario.order.length > 1 && (
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

          {/* Typing a folder that doesn't exist yet CREATES it, right here
              (Combobox's create row) — a customer you are meeting for the first
              time is one keystroke from having somewhere to live. */}
          <Field label={t("preflight.field.folder")}>
            <FolderPicker value={folderId} onChange={setMeetingFolder} />
          </Field>
        </div>

        {/* The other save decision: an org copy — a second destination, never
            a move. (Signed-out / OSS: this whole block is absent.) */}
        {CLOUD_ENABLED && signedIn && syncEnabled && (
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <SectionTitle>{t("share.toOrg")}</SectionTitle>
            <OrgSharePicker
              value={
                orgShare === "off"
                  ? null
                  : orgShare ??
                    (defaultSave.scope === "org" && defaultSave.orgId
                      ? { orgId: defaultSave.orgId, folderId: defaultSave.folderId ?? null }
                      : null)
              }
              onChange={(target) => {
                // Picking "off" while the settings default would share needs an
                // explicit suppression, not just null (null = follow default).
                if (target) setOrgShare(target);
                else setOrgShare(defaultSave.scope === "org" ? "off" : null);
              }}
            />
            {save.autoShare && (
              <p className="text-[11px] text-muted-foreground">{t("preflight.saveOrgCopy")}</p>
            )}
          </div>
        )}
      </div>
    </Column>
  );
}
