import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Keyboard, Loader2, RotateCcw } from "lucide-react";
import { DEFAULT_VOICE_TYPING_SHORTCUT, useStore } from "../lib/store";
import { useI18n, type TranslationKey } from "../i18n";
import { isMac } from "../lib/platform";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import { log } from "../lib/log";
import { hasProviderKey } from "../lib/ai/settings";
import { isModifierId, modifierIdsFor, shortcutCaps } from "../lib/voiceTyping/caps";
import { loneModifierRelease, MODIFIER_CODES } from "../lib/voiceTyping/recorder";
import type {
  VoiceTypingMode,
  VoiceTypingPolishStyle,
  VoiceTypingShortcut,
} from "../lib/types";
import { Button } from "@/components/ui/button";

/** The polish styles in the order the picker shows them, with their name and
 *  the one line saying what each does to the words. */
const POLISH_STYLE_OPTIONS: readonly {
  style: VoiceTypingPolishStyle;
  label: TranslationKey;
  hint: TranslationKey;
}[] = [
  {
    style: "off",
    label: "settings.voiceTyping.polishStyle.off",
    hint: "settings.voiceTyping.polishStyle.offHint",
  },
  {
    style: "tidy",
    label: "settings.voiceTyping.polishStyle.tidy",
    hint: "settings.voiceTyping.polishStyle.tidyHint",
  },
  {
    style: "concise",
    label: "settings.voiceTyping.polishStyle.concise",
    hint: "settings.voiceTyping.polishStyle.conciseHint",
  },
];

interface HotkeyStatus {
  authorized: boolean;
  active: boolean;
  shortcut: string;
  /** How the trigger is wired: "combo" (OS global shortcut) | "tap-active"
   *  (HID tap, can swallow the key) | "tap-listen" (HID tap can only observe
   *  the key — matters for fn, whose native 🌐 action still fires) | "hook"
   *  (Windows low-level keyboard hook, observes only) | "none". */
  mode: string;
}

/** The combo id a recorded keydown selects, or null when the press needs a
 *  modifier (a bare letter would swallow ordinary typing system-wide). */
function comboFromEvent(e: KeyboardEvent): VoiceTypingShortcut | null {
  const mods = [
    e.metaKey ? "super" : null,
    e.ctrlKey ? "control" : null,
    e.altKey ? "alt" : null,
    e.shiftKey ? "shift" : null,
  ].filter((m): m is string => m !== null);
  const isFKey = /^F([1-9]|1\d|2[0-4])$/.test(e.code);
  if (mods.length === 0 && !isFKey) return null;
  return `combo:${[...mods, e.code].join("+")}` as VoiceTypingShortcut;
}

/**
 * Register `shortcut` with the backend and return the resulting status (null
 * when the apply itself failed). A single-key trigger needs Input Monitoring —
 * request it right when the user picks one (the permission follows the
 * feature), then re-apply so the tap arms immediately if macOS granted
 * without a relaunch.
 */
async function applyShortcut(shortcut: VoiceTypingShortcut): Promise<HotkeyStatus | null> {
  const s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(
    (error) => {
      log.warn("voice typing settings: shortcut apply failed", {
        shortcut,
        error: String(error),
      });
      return null;
    },
  );
  if (!s || !isModifierId(shortcut) || s.authorized) return s;
  await invoke("request_input_monitoring").catch((error) =>
    log.warn("voice typing settings: input monitoring request failed", {
      shortcut,
      error: String(error),
    }),
  );
  return invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch((error) => {
    log.warn("voice typing settings: shortcut reapply failed", {
      shortcut,
      error: String(error),
    });
    return s;
  });
}

/**
 * Key-capture mode: the settings window is focused, so plain DOM key events
 * are enough — no global listener, no extra permission. Esc cancels; a combo
 * must include a modifier (or be an F-key) so a bare letter can't be armed as
 * a system-wide hotkey that swallows normal typing.
 */
function useShortcutRecorder(
  recording: boolean,
  chooseShortcut: (shortcut: VoiceTypingShortcut) => Promise<void>,
  setRecording: (recording: boolean) => void,
  setRecordHint: (hint: TranslationKey | null) => void,
) {
  /** Set once any non-modifier keydown happens in the current recording
   *  session — a later lone-modifier keyup then no longer picks a hold-key. */
  const sawNonModifierRef = useRef(false);

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
      const combo = comboFromEvent(e);
      if (!combo) {
        setRecordHint(
          isMac()
            ? "settings.voiceTyping.recorder.needModifier"
            : "settings.voiceTyping.recorder.needModifierWindows",
        );
        return;
      }
      setRecording(false);
      setRecordHint(null);
      chooseShortcut(combo).catch((error) =>
        log.error("voice-typing: choose combo shortcut failed", { error: String(error) }),
      );
    };
    // Users routinely press a lone modifier here hoping to pick it as a
    // hold-key — see `loneModifierRelease` for what each one means. Skipped as
    // soon as any non-modifier key was involved.
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (sawNonModifierRef.current) return;
      const outcome = loneModifierRelease(e.code, isMac());
      if (!outcome) return;
      if ("hint" in outcome) {
        setRecordHint(outcome.hint);
        return;
      }
      const shortcut = outcome.select;
      setRecording(false);
      setRecordHint(null);
      chooseShortcut(shortcut).catch((error) =>
        log.error("voice-typing: choose modifier shortcut failed", {
          error: String(error),
          shortcut,
        }),
      );
    };
    const cancel = () => {
      setRecording(false);
      setRecordHint(null);
    };
    globalThis.addEventListener("keydown", onKey, true);
    globalThis.addEventListener("keyup", onKeyUp, true);
    globalThis.addEventListener("blur", cancel);
    return () => {
      globalThis.removeEventListener("keydown", onKey, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      globalThis.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
}

/** The recorder button's leading icon: spinner while saving, pulsing dot while
 *  capturing, otherwise the keyboard glyph. */
function recorderIcon(saving: boolean, recording: boolean): ReactNode {
  if (saving) return <Loader2 className="size-3.5 animate-spin" />;
  if (recording) return <Circle className="size-2.5 animate-pulse fill-current" />;
  return <Keyboard className="size-3.5" />;
}

interface AppIdentity {
  bundleIdentifier: string;
  executablePath: string;
  runningFromAppBundle: boolean;
  likelyDevBinary: boolean;
}

/** Whether the trigger the user picked can actually fire, and what stands in
 *  its way. */
interface TriggerState {
  /** A hold-a-modifier trigger is selected but the HID tap has no Input
   *  Monitoring grant, so nothing is watching the key. */
  needsPermission: boolean;
  /** A combo is selected but the OS refused to register it — something else
   *  already owns that chord. */
  comboConflict: boolean;
  /** Some listener is armed for the current trigger. */
  active: boolean;
  /** The tap can observe fn but not swallow it, so macOS still runs the 🌐
   *  action (emoji picker/dictation) on every press — worth a heads-up. */
  fnListenOnly: boolean;
}

/**
 * Read the backend's verdict on the selected trigger. One decision, four
 * answers: they all turn on the same pair of facts (which kind of trigger is
 * selected, and what the last `HotkeyStatus` said), so deriving them together
 * keeps them from drifting apart.
 *
 * `mac` gates three of the four because they are macOS-only permission
 * stories: Input Monitoring, the HID tap behind the hold-a-modifier triggers
 * and the fn 🌐 override all describe grants and machinery Windows does not
 * have, so raising them there would ask the user to fix something that isn't
 * broken. `status` is null until the first backend answer arrives — nothing is
 * known to be wrong yet, so every warning stays quiet.
 */
function describeTrigger(
  mac: boolean,
  selected: string,
  status: HotkeyStatus | null,
): TriggerState {
  const selectedIsModifier = isModifierId(selected);
  return {
    needsPermission: mac && selectedIsModifier && status != null && !status.authorized,
    comboConflict: !selectedIsModifier && status != null && !status.active,
    active: !!status?.active,
    fnListenOnly: mac && selected === "fn" && status?.mode === "tap-listen",
  };
}

/**
 * Voice-typing options. The push-to-talk trigger is picked one of two ways —
 * exactly one trigger is live at a time (the backend unregisters everything
 * before applying a change):
 *   - Record any key combo (modifiers + key, or an F-key): registered as an OS
 *     global shortcut, works with NO extra permission. This is the default path
 *     (⌥ Space on macOS, Ctrl+Alt+Space on Windows — Alt+Space there is the
 *     native window system menu).
 *   - Hold a single modifier key (fn / right ⌥⌘⌃): needs Input Monitoring —
 *     requested HERE, at the moment of picking the key (permissions follow the
 *     feature; the Permissions tab only carries the meeting-critical ones).
 *     On Windows only right Ctrl / right Alt, through a low-level keyboard
 *     hook that needs no permission; a hook that failed to install shows as
 *     "not active" in the status badge.
 *
 * The Input Monitoring warning and the Accessibility warning describe macOS
 * grants, so they are hidden on Windows rather than shown dead.
 *
 * Releasing the key always auto-pastes (no separate setting); on macOS the
 * Accessibility grant that needs is requested when voice typing is enabled
 * (host.ts also asks at launch while the feature is on). Windows needs no
 * grant: the injection either lands or UIPI refuses it for an elevated target,
 * and the overlay says so at that moment. What Windows does lose is the
 * dictionary's learning loop — watching the pasted-into field for a correction
 * needs an accessibility observer that only macOS has — so the panel says so
 * rather than letting the feature look self-teaching everywhere.
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

  const refreshStatus = useCallback(() => {
    invoke<HotkeyStatus>("voice_typing_hotkey_status")
      .then((s) => setStatus(s))
      .catch((error) =>
        log.warn("voice typing settings: hotkey status refresh failed", { error: String(error) }),
      );
    // Auto-paste needs Accessibility; the boot-time prompt asks at most once
    // per install, so this panel is the visible surface for a missing/stale
    // grant (stale = the TCC identity changed: dev rebuilds, re-signing).
    // macOS only — Windows has no such grant to be missing (the backend always
    // answers true), so asking would just be a round trip to a constant.
    if (!isMac()) return;
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
      const s = await applyShortcut(shortcut);
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

  useShortcutRecorder(recording, chooseShortcut, setRecording, setRecordHint);
  if (!isTauri()) return null;

  // Windows has none of the Accessibility / Input Monitoring grants the macOS
  // tap and auto-paste ask for, so those warnings never show there.
  const mac = isMac();
  const selected = settings.voiceTypingShortcut;
  const { needsPermission, comboConflict, active, fnListenOnly } = describeTrigger(
    mac,
    selected,
    status,
  );

  const setVoiceTypingEnabled = (enabled: boolean) => {
    updateSettings({ voiceTypingEnabled: enabled });
    broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
      log.warn("settings: broadcast failed", { error: String(error) }),
    );
    // Voice typing always auto-pastes, which on macOS needs Accessibility —
    // enabling the feature is the moment to ask for its permission. Windows
    // has no equivalent grant, so there is nothing to ask for there.
    if (enabled && isMac()) {
      invoke("accessibility_status", { prompt: true }).catch((error) =>
        log.warn("permissions: accessibility prompt failed", { error: String(error) }),
      );
    }
  };

  const setVoiceTypingMode = (mode: VoiceTypingMode) => {
    updateSettings({ voiceTypingMode: mode });
    broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
      log.warn("voice typing settings: broadcast failed", { error: String(error) }),
    );
  };
  const mode = settings.voiceTypingMode;

  const setVoiceTypingPolishStyle = (style: VoiceTypingPolishStyle) => {
    updateSettings({ voiceTypingPolishStyle: style });
    broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
      log.warn("voice typing settings: broadcast failed", { error: String(error) }),
    );
  };
  // The picker stays operable without a realtime provider — choosing a style
  // is how someone decides they want this, and the note tells them the one
  // thing left to do. Disabling the control would leave them guessing why
  // nothing happens.
  const polishHasProvider = hasProviderKey(settings, "realtime");
  const polishStyle = settings.voiceTypingPolishStyle;
  const polishOption =
    POLISH_STYLE_OPTIONS.find((o) => o.style === polishStyle) ?? POLISH_STYLE_OPTIONS[1];

  // Guidance renders as single inline lines (no nested boxes) and only when
  // actionable — the default state is just the recorder, the chips and one
  // caption.
  const icon = recorderIcon(saving, recording);
  // The caption under the recorder names the ways a trigger can be picked, so
  // it differs by platform: holding a key needs Input Monitoring only on
  // macOS, and Windows adds the Alt+Space caveat. (While capture is armed the
  // caption says how to back out instead.)
  const recorderHelpKey: TranslationKey = mac
    ? "settings.voiceTyping.recorder.help"
    : "settings.voiceTyping.recorder.helpWindows";

  return (
    <div className="flex max-w-md flex-col gap-6">
      <div className="flex flex-col gap-1.5">
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
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{t("settings.voiceTyping.polish")}</span>
            <span className="text-[11px] text-muted-foreground">{t(polishOption.hint)}</span>
          </span>
          <div className="flex shrink-0 gap-1.5" role="radiogroup">
            {POLISH_STYLE_OPTIONS.map((o) => (
              <Button
                key={o.style}
                role="radio"
                aria-checked={polishStyle === o.style}
                variant={polishStyle === o.style ? "secondary" : "outline"}
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setVoiceTypingPolishStyle(o.style)}
              >
                {t(o.label)}
              </Button>
            ))}
          </div>
        </div>
        {polishStyle !== "off" && !polishHasProvider && (
          <p className="text-[11px] text-warning-foreground">
            {t("settings.voiceTyping.polishNoProvider")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.voiceTyping.mode")}
          </span>
          <div className="flex shrink-0 gap-1.5">
            {(["hold", "toggle"] as const).map((m) => (
              <Button
                key={m}
                variant={mode === m ? "secondary" : "outline"}
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setVoiceTypingMode(m)}
              >
                {t(
                  m === "hold"
                    ? "settings.voiceTyping.mode.hold"
                    : "settings.voiceTyping.mode.toggle",
                )}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t(
            mode === "toggle"
              ? "settings.voiceTyping.mode.toggleHint"
              : "settings.voiceTyping.mode.holdHint",
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.voiceTyping.shortcut")}
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${
              active
                ? "text-success-foreground"
                : "text-warning-foreground"
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
            {icon}
            {recording ? (
              <span className="text-xs">{t("settings.voiceTyping.recorder.listening")}</span>
            ) : (
              <span className="font-mono tracking-wide">{shortcutCaps(selected, t)}</span>
            )}
          </button>
          {/* Reset goes to the PLATFORM default, not to ⌥ Space: on Windows
              that chord is the native window system menu, so offering it as
              "the safe one to go back to" would hand the user a trigger that
              collides with the OS. */}
          {selected !== DEFAULT_VOICE_TYPING_SHORTCUT && !recording && (
            <Button
              variant="ghost"
              size="sm"
              className="h-10 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground"
              title={t("settings.voiceTyping.recorder.reset", {
                keys: shortcutCaps(DEFAULT_VOICE_TYPING_SHORTCUT, t),
              })}
              onClick={() =>
                chooseShortcut(DEFAULT_VOICE_TYPING_SHORTCUT).catch((error) =>
                  log.error("voice-typing: reset shortcut failed", { error: String(error) }),
                )
              }
            >
              <RotateCcw className="size-3.5" />
              {shortcutCaps(DEFAULT_VOICE_TYPING_SHORTCUT, t)}
            </Button>
          )}
        </div>

        {/* Hold-a-modifier alternative: the HID tap on macOS (needs Input
            Monitoring), a low-level keyboard hook on Windows (right Ctrl /
            right Alt only — a PC keyboard has no fn or ⌘). */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.modifierSection")}
          </span>
          <div className={`grid flex-1 gap-1.5 ${mac ? "grid-cols-4" : "grid-cols-2"}`}>
            {modifierIdsFor(mac).map((id) => (
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
                {shortcutCaps(id, t, mac)}
              </Button>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {recording ? t("settings.voiceTyping.recorder.cancelHint") : t(recorderHelpKey)}
        </p>
        {recordHint && (
          <p className="text-[11px] font-medium text-warning-foreground">
            {t(recordHint)}
          </p>
        )}
        {comboConflict && (
          <p className="text-[11px] font-medium text-warning-foreground">
            {t("settings.voiceTyping.recorder.conflict")}
          </p>
        )}
        {needsPermission && (
          <p className="text-[11px] text-warning-foreground">
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
        {mac && settings.voiceTypingEnabled && axTrusted === false && (
          <p className="text-[11px] text-warning-foreground">
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
