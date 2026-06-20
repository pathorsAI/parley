import { useState } from "react";
import { Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { runSpeakerReassign } from "../../lib/speakers/engine";
import { describeAiError } from "../../lib/ai/errors";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SpeakerRole } from "../../lib/types";

/**
 * Define roles and let the LLM re-attribute every transcript line to one of them
 * — a fix for unreliable STT speaker diarization. Applies straight to the store
 * (segments + speakerNames), so the transcript and all analyses update at once.
 */
export function SpeakerReassignDialog({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n();
  const userName = useStore((s) => s.settings.userName);

  const [roles, setRoles] = useState<SpeakerRole[]>(() => [
    { name: userName?.trim() || (language === "en" ? "Me" : "我"), hint: "" },
    { name: language === "en" ? "Them" : "對方", hint: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setRole(i: number, patch: Partial<SpeakerRole>) {
    setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRole() {
    setRoles((rs) => [...rs, { name: "", hint: "" }]);
  }
  function removeRole(i: number) {
    setRoles((rs) => (rs.length > 2 ? rs.filter((_, idx) => idx !== i) : rs));
  }

  const validRoles = roles.map((r) => ({ name: r.name.trim(), hint: r.hint?.trim() })).filter((r) => r.name);
  const canRun = validRoles.length >= 2 && !busy;

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      await runSpeakerReassign(validRoles);
      onClose();
    } catch (err) {
      setError(describeAiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={busy ? undefined : onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Sparkles className="size-4 text-sky-400" />
          <span className="text-sm font-semibold">{t("speakers.reassignTitle")}</span>
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" disabled={busy} onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{t("speakers.reassignIntro")}</p>

          <div className="flex flex-col gap-2">
            {roles.map((r, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="mt-2 w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Input
                    value={r.name}
                    onChange={(e) => setRole(i, { name: e.target.value })}
                    placeholder={t("speakers.roleName")}
                    className="h-8 text-sm"
                  />
                  <Input
                    value={r.hint ?? ""}
                    onChange={(e) => setRole(i, { hint: e.target.value })}
                    placeholder={t("speakers.roleHintPlaceholder")}
                    className="h-7 text-[11px]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeRole(i)}
                  disabled={roles.length <= 2}
                  className="mt-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title={t("speakers.removeRole")}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addRole}
            className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t("speakers.addRole")}
          </button>

          {error && (
            <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
              {t("speakers.failed", { error })}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("speakers.cancel")}
          </button>
          <Button size="sm" className="h-8 gap-1.5" disabled={!canRun} onClick={() => void run()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {busy ? t("speakers.running") : t("speakers.run")}
          </Button>
        </div>
      </div>
    </div>
  );
}
