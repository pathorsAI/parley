import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { DeliveryCoach } from "./delivery";
import type { DeliveryNudgeKind, ProsodyMetrics } from "../types";

/** Selector for the gauges: latest prosody metrics (null until the first event). */
export function useProsody(): ProsodyMetrics | null {
  return useStore((s) => s.prosody);
}

/** i18n key for each mic-derived nudge kind. "tone" and "filler" are supplied by
 *  the LLM-driven analysis engine, which pushes its own localized message. */
const NUDGE_KEY: Record<Exclude<DeliveryNudgeKind, "tone" | "filler">, TranslationKey> = {
  pace: "delivery.nudge.pace",
  monotone: "delivery.nudge.monotone",
  steamroll: "delivery.nudge.steamroll",
  deadair: "delivery.nudge.deadair",
  filledpause: "delivery.nudge.filledpause",
};

/**
 * LIVE delivery coach: while recording, watches the prosody stream and pushes
 * self-calibrating nudges (pace / monotone / steamroll / dead-air) to the store
 * for {@link DeliveryNudgeHost} to render. Mount once (in MeetingView). The LLM
 * *tone* nudge is pushed separately by the analysis engine. No-op off-air.
 *
 * The coach is rebuilt per meeting and whenever the toggles change (which resets
 * its baselines); it's driven off the `prosody` slice, which updates ~2×/s.
 */
export function useDeliveryCoach(): void {
  const meetingStatus = useStore((s) => s.meetingStatus);
  const startedAt = useStore((s) => s.meetingStartedAt);
  // Depend on primitive flags, NOT the `delivery` object: its identity changes on
  // every settings mutation (updateSettings spreads, applySettings replaces the
  // whole object on cross-window sync), which would otherwise rebuild the coach —
  // wiping its calibration baselines + cooldowns — on any unrelated settings edit.
  const pace = useStore((s) => s.settings.delivery.pace);
  const pitch = useStore((s) => s.settings.delivery.pitch);
  const pauses = useStore((s) => s.settings.delivery.pauses);
  const tone = useStore((s) => s.settings.delivery.tone);
  const prosody = useStore((s) => s.prosody);
  const { t } = useI18n();

  const coachRef = useRef<DeliveryCoach | null>(null);
  // Keep the latest translator in a ref so the prosody effect needn't depend on
  // `t` (whose identity changes every render) and re-subscribe constantly.
  const messageRef = useRef<(k: Exclude<DeliveryNudgeKind, "tone" | "filler">) => string>(() => "");
  messageRef.current = (k) => t(NUDGE_KEY[k]);

  // (Re)create the coach per meeting and only when an actual delivery flag flips
  // (primitive deps), so its baselines/cooldowns survive unrelated settings edits.
  useEffect(() => {
    coachRef.current =
      meetingStatus === "recording" ? new DeliveryCoach({ pace, pitch, pauses, tone }) : null;
  }, [meetingStatus, startedAt, pace, pitch, pauses, tone]);

  // Drop any stored assessment when the tone/filler toggle flips, so re-enabling
  // shows the waiting state until a fresh pass populates it (never a stale read).
  useEffect(() => {
    useStore.getState().setDeliveryAssessment(null);
  }, [tone]);

  // Feed each new prosody sample to the coach; surface any resulting nudge.
  useEffect(() => {
    if (meetingStatus !== "recording" || !prosody) return;
    const coach = coachRef.current;
    if (!coach) return;
    const nowMs = startedAt ? Date.now() - startedAt : 0;
    const trigger = coach.observe(prosody, nowMs);
    // The coach only emits mic-derived kinds; tone/filler are LLM-pushed elsewhere.
    if (!trigger || trigger.kind === "tone" || trigger.kind === "filler") return;
    useStore.getState().pushDeliveryNudge({
      kind: trigger.kind,
      severity: trigger.severity,
      message: messageRef.current(trigger.kind),
    });
  }, [prosody, meetingStatus, startedAt]);
}
