import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Keyboard, Loader2, RotateCcw } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n, type TranslationKey } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import { log } from "../lib/log";
import type { VoiceTypingShortcut } from "../lib/types";
import { Button } from "@/components/ui/button";

interface HotkeyStatus {
  authorized: boolean;
  active: boolean;
  shortcut: string;
  /** How the trigger is wired: "combo" (OS global shortcut) | "tap-active"
   *  (HID tap, can swallow the key) | "tap-listen" (HID tap can only observe
   *  the key — matters for fn, whose native 🌐 action still fires) | "none". */
  mode: string;
}

/** The hold-friendly single modifier keys watched by the HID tap (need Input
 *  Monitoring). Everything else is an OS global shortcut (no permission). */
const MODIFIER_IDS = ["fn", "right-option", "right-command", "right-control"] as const;
type ModifierId = (typeof MODIFIER_IDS)[number];

const MODIFIER_LABEL_KEYS: Record<ModifierId, TranslationKey> = {
  fn: "settings.voiceTyping.shortcut.fn",
  "right-option": "settings.voiceTyping.shortcut.right-option",
  "right-command": "settings.voiceTyping.shortcut.right-command",
  "right-control": "settings.voiceTyping.shortcut.right-control",
};

const isModifierId = (s: string): s is ModifierId =>
  (MODIFIER_IDS as readonly string[]).includes(s);

/** Keys that never end a recording on their own — we wait for the main key. */
const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

/** Right-side modifiers double as hold-to-talk keys: releasing one alone while
 *  recording selects the matching HID-tap option instead of a combo. */
const RIGHT_MODIFIER_BY_CODE: Record<string, ModifierId> = {
  MetaRight: "right-command",
  AltRight: "right-option",
  ControlRight: "right-control",
};

/** Lone left-side/Shift releases are deliberately NOT selectable — they fire
 *  during every ordinary shortcut (⌘C, ⇧-typing…), so holding one would
 *  constantly collide. The recorder shows a hint pointing at the right-side
 *  chips instead. (fn never reaches the DOM at all; its chip is the only way.) */
const LEFT_MODIFIER_CODES = new Set([
  "MetaLeft",
  "AltLeft",
  "ControlLeft",
  "ShiftLeft",
  "ShiftRight",
]);

const MOD_SYMBOL: Record<string, string> = {
  super: "⌘",
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
};

/** Human label for a W3C KeyboardEvent.code token. */
function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const MAP: Record<string, string> = {
    Space: "Space",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "↩",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Home: "↖",
    End: "↘",
    PageUp: "⇞",
    PageDown: "⇟",
  };
  return MAP[code] ?? code;
}

/** Render the stored shortcut id as mac-style key caps, e.g. "⌃ ⇧ D". */
export function shortcutCaps(shortcut: string, t: (k: TranslationKey) => string): string {
  if (shortcut === "alt-space") return "⌥ Space";
  if (isModifierId(shortcut)) return t(MODIFIER_LABEL_KEYS[shortcut]);
  if (shortcut.startsWith("combo:")) {
    return shortcut
      .slice("combo:".length)
      .split("+")
      .map((part) => MOD_SYMBOL[part] ?? keyLabel(part))
      .join(" ");
  }
  return shortcut;
}

interface AppIdentity {
  bundleIdentifier: string;
  executablePath: string;
  runningFromAppBundle: boolean;
  likelyDevBinary: boolean;
}

/**
 * Voice-typing options. The push-to-talk trigger is picked one of two ways —
 * exactly one trigger is live at a time (the backend unregisters everything
 * before applying a change):
 *   - Record any key combo (modifiers + key, or an F-key): registered as an OS
 *     global shortcut, works with NO extra permission. This is the default path
 *     (⌥ Space out of the box).
 *   - Hold a single modifier key (fn / right ⌥⌘⌃): needs Input Monitoring —
 *     requested HERE, at the moment of picking the key (permissions follow the
 *     feature; the Permissions tab only carries the meeting-critical ones).
 * Releasing the key always auto-pastes (no separate setting); the Accessibility
 * grant that needs is requested when voice typing is enabled (host.ts also asks
 * at launch while the feature is on).
 */
export const VoiceTypingSettings = () => {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [identity, setIdentity] = useState<AppIdentity | null>(null);
  /** Accessibility (auto-paste) trust — null until the first check resolves. */
  const [axTrusted, setAxTrusted] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordHint, setRecordHint] = useState<TranslationKey | null>(null);
  /** Set once any non-modifier keydown happens in the current recording
   *  session — a later lone-modifier keyup then no longer picks a hold-key. */
  const sawNonModifierRef = useRef(false);

  const refreshStatus = useCallback(() => {
    invoke<HotkeyStatus>("voice_typing_hotkey_status")
      .then((s) => setStatus(s))
      .catch((error) =>
        log.warn("voice typing settings: hotkey status refresh failed", { error: String(error) }),
      );
    // Auto-paste needs Accessibility; the boot-time prompt asks at most once
    // per install, so this panel is the visible surface for a missing/stale
    // grant (stale = the TCC identity changed: dev rebuilds, re-signing).
    invoke<boolean>("accessibility_status", { prompt: false })
      .then(setAxTrusted)
      .catch((error) =>
        log.warn("voice typing settings: accessibility status refresh failed", {
          error: String(error),
        }),
      );
  }, []);

  // Fetch on mount, and re-check whenever the window regains focus or becomes
  // visible again — the user may have just granted a permission on the
  // Permissions tab or in System Settings, which changes the badge and mode.
  useEffect(() => {
    if (!isTauri()) return;
    refreshStatus();
    invoke<AppIdentity>("app_identity")
      .then(setIdentity)
      .catch((error) =>
        log.warn("voice typing settings: app identity lookup failed", { error: String(error) }),
      );
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshStatus();
    };
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshStatus]);

  const chooseShortcut = async (shortcut: VoiceTypingShortcut) => {
    setSaving(true);
    try {
      updateSettings({ voiceTypingShortcut: shortcut });
      broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
        log.warn("voice typing settings: broadcast failed", { error: String(error) }),
      );
      let s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(
        (error) => {
          log.warn("voice typing settings: shortcut apply failed", {
            shortcut,
            error: String(error),
          });
          return null;
        },
      );
      // A single-key trigger needs Input Monitoring — request it right when the
      // user picks one (the permission follows the feature), then re-apply so the
      // tap arms immediately if macOS granted without a relaunch.
      if (s && isModifierId(shortcut) && !s.authorized) {
        await invoke("request_input_monitoring").catch((error) =>
          log.warn("voice typing settings: input monitoring request failed", {
            shortcut,
            error: String(error),
          }),
        );
        s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(
          (error) => {
            log.warn("voice typing settings: shortcut reapply failed", {
              shortcut,
              error: String(error),
            });
            return s;
          },
        );
      }
      if (s) setStatus(s);
    } finally {
      setSaving(false);
    }
  };

  /** Re-request Input Monitoring from the inline warning (repeat clicks land in
   *  the right System Settings pane since the OS prompt only fires once). */
  const grantInputMonitoring = async () => {
    await invoke("request_input_monitoring").catch((error) =>
      log.warn("voice typing settings: input monitoring request failed", { error: String(error) }),
    );
    await invoke("open_privacy_settings", { pane: "input-monitoring" }).catch((error) =>
      log.warn("voice typing settings: open input monitoring settings failed", {
        error: String(error),
      }),
    );
    await invoke("ensure_fn_listener").catch((error) =>
      log.warn("voice typing settings: fn listener setup failed", { error: String(error) }),
    );
    refreshStatus();
  };

  /** Re-request Accessibility from the inline warning. Same shape as
   *  grantInputMonitoring: the native dialog only fires once per identity, so
   *  repeat clicks land the user in the right System Settings pane instead of
   *  appearing dead. */
  const grantAccessibility = async () => {
    await invoke("accessibility_status", { prompt: true }).catch((error) =>
      log.warn("voice typing settings: accessibility request failed", { error: String(error) }),
    );
    await invoke("open_privacy_settings", { pane: "accessibility" }).catch((error) =>
      log.warn("voice typing settings: open accessibility settings failed", {
        error: String(error),
      }),
    );
    refreshStatus();
  };

  // Key-capture mode: the settings window is focused, so plain DOM key events
  // are enough — no global listener, no extra permission. Esc cancels; a combo
  // must include a modifier (or be an F-key) so a bare letter can't be armed as
  // a system-wide hotkey that swallows normal typing.
  useEffect(() => {
    if (!recording) return;
    sawNonModifierRef.current = false;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        setRecordHint(null);
        return;
      }
      if (MODIFIER_CODES.has(e.code)) return; // still holding — wait for the key
      sawNonModifierRef.current = true; // a combo was attempted
      const mods = [
        e.metaKey ? "super" : null,
        e.ctrlKey ? "control" : null,
        e.altKey ? "alt" : null,
        e.shiftKey ? "shift" : null,
      ].filter((m): m is string => m !== null);
      const isFKey = /^F([1-9]|1\d|2[0-4])$/.test(e.code);
      if (mods.length === 0 && !isFKey) {
        setRecordHint("settings.voiceTyping.recorder.needModifier");
        return;
      }
      setRecording(false);
      setRecordHint(null);
      chooseShortcut(`combo:${[...mods, e.code].join("+")}` as VoiceTypingShortcut).catch((error) =>
        log.error("voice-typing: choose combo shortcut failed", { error: String(error) }),
      );
    };
    // Users routinely press a lone modifier here hoping to pick it as a
    // hold-key. A tap only becomes distinguishable from "start of a combo" at
    // keyup, so react there: a lone right-side modifier is selected directly
    // (same as clicking its chip below); left-side/Shift get an explanatory
    // hint. Skipped as soon as any non-modifier key was involved.
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (sawNonModifierRef.current) return;
      const rightId = RIGHT_MODIFIER_BY_CODE[e.code];
      if (rightId) {
        setRecording(false);
        setRecordHint(null);
        chooseShortcut(rightId).catch((error) =>
          log.error("voice-typing: choose modifier shortcut failed", { error: String(error), shortcut: rightId }),
        );
        return;
      }
      if (LEFT_MODIFIER_CODES.has(e.code)) {
        setRecordHint("settings.voiceTyping.recorder.leftModifier");
      }
    };
    const cancel = () => {
      setRecording(false);
      setRecordHint(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  if (!isTauri()) return null;

  const selected = settings.voiceTypingShortcut;
  const selectedIsModifier = isModifierId(selected);
  const needsPermission = selectedIsModifier && status != null && !status.authorized;
  const comboConflict = !selectedIsModifier && status != null && !status.active;
  const active = !!status?.active;
  // The tap can observe fn but not swallow it, so macOS still runs the 🌐
  // action (emoji picker/dictation) on every press — worth a heads-up.
  const fnListenOnly = selected === "fn" && status?.mode === "tap-listen";

  const setVoiceTypingEnabled = (enabled: boolean) => {
    updateSettings({ voiceTypingEnabled: enabled });
    broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
      log.warn("settings: broadcast failed", { error: String(error) }),
    );
    // Voice typing always auto-pastes, which needs Accessibility — enabling the
    // feature is the moment to ask for its permission.
    if (enabled) {
      invoke("accessibility_status", { prompt: true }).catch((error) =>
        log.warn("permissions: accessibility prompt failed", { error: String(error) }),
      );
    }
  };

  // Guidance renders as single inline lines (no nested boxes) and only when
  // actionable — the default state is just the recorder, the chips and one
  // caption.
  return (
    <div className="flex max-w-md flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{t("settings.voiceTyping.pushToTalk")}</span>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.hint")}
          </span>
        </span>
        <Button
          variant={settings.voiceTypingEnabled ? "outline" : "default"}
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => setVoiceTypingEnabled(!settings.voiceTypingEnabled)}
        >
          {settings.voiceTypingEnabled
            ? t("settings.voiceTyping.disable")
            : t("settings.voiceTyping.enable")}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.voiceTyping.shortcut")}
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${
              active
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {active ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            {active
              ? t("settings.voiceTyping.listenerActive")
              : t("settings.voiceTyping.listenerInactive")}
          </span>
        </div>

        {/* Recorder: click, then press the combo you want. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setRecordHint(null);
              setRecording((r) => !r);
            }}
            className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-md border text-sm transition-colors ${
              recording
                ? "border-primary bg-primary/10 text-primary"
                : "hover:bg-muted/50"
            }`}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : recording ? (
              <Circle className="size-2.5 animate-pulse fill-current" />
            ) : (
              <Keyboard className="size-3.5" />
            )}
            {recording ? (
              <span className="text-xs">{t("settings.voiceTyping.recorder.listening")}</span>
            ) : (
              <span className="font-mono tracking-wide">{shortcutCaps(selected, t)}</span>
            )}
          </button>
          {selected !== "alt-space" && !recording && (
            <Button
              variant="ghost"
              size="sm"
              className="h-10 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground"
              title={t("settings.voiceTyping.recorder.reset")}
              onClick={() =>
                chooseShortcut("alt-space").catch((error) =>
                  log.error("voice-typing: reset shortcut failed", { error: String(error) }),
                )
              }
            >
              <RotateCcw className="size-3.5" />
              ⌥ Space
            </Button>
          )}
        </div>

        {/* Hold-a-modifier alternative (HID tap; needs Input Monitoring). */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.modifierSection")}
          </span>
          <div className="grid flex-1 grid-cols-4 gap-1.5">
            {MODIFIER_IDS.map((id) => (
              <Button
                key={id}
                variant={selected === id ? "secondary" : "outline"}
                size="sm"
                className="h-7 justify-center px-1.5 text-[11px]"
                onClick={() =>
                  chooseShortcut(id).catch((error) =>
                    log.error("voice-typing: choose modifier shortcut failed", { error: String(error), shortcut: id }),
                  )
                }
              >
                {t(MODIFIER_LABEL_KEYS[id])}
              </Button>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {recording
            ? t("settings.voiceTyping.recorder.cancelHint")
            : t("settings.voiceTyping.recorder.help")}
        </p>
        {recordHint && (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {t(recordHint)}
          </p>
        )}
        {comboConflict && (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {t("settings.voiceTyping.recorder.conflict")}
          </p>
        )}
        {needsPermission && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {t("settings.voiceTyping.needsInputMonitoring")}{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() =>
                grantInputMonitoring().catch((error) =>
                  log.error("permissions: input monitoring grant failed", { error: String(error) }),
                )
              }
            >
              {t("settings.voiceTyping.grant")}
            </button>
          </p>
        )}
        {needsPermission && identity?.likelyDevBinary && (
          <p className="break-all text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.devBinaryHint", { path: identity.executablePath })}
          </p>
        )}
        {settings.voiceTypingEnabled && axTrusted === false && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {t("settings.voiceTyping.needsAccessibility")}{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() =>
                grantAccessibility().catch((error) =>
                  log.error("permissions: accessibility grant failed", { error: String(error) }),
                )
              }
            >
              {t("settings.voiceTyping.grantAccessibility")}
            </button>
          </p>
        )}
        {fnListenOnly && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.voiceTyping.fnListenOnly")}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                invoke("open_privacy_settings", { pane: "keyboard" }).catch((error) =>
                  log.warn("permissions: open keyboard settings failed", { error: String(error) }),
                );
              }}
            >
              {t("settings.voiceTyping.openKeyboardSettings")}
            </button>
            {" · "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() =>
                grantAccessibility().catch((error) =>
                  log.error("permissions: accessibility grant failed", { error: String(error) }),
                )
              }
            >
              {t("settings.voiceTyping.grantAccessibility")}
            </button>
          </p>
        )}
      </div>
    </div>
  );
};
