import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/tauriEvents";

interface LevelPayload {
  source: string;
  level: number;
}

/**
 * Live input-level meter fed by the backend `audio://level` event. Speech peaks
 * are numerically small, so we map with sqrt for a perceptually useful bar.
 */
export const LevelMeter = ({
  source,
  className,
  eventName = "audio://level",
}: {
  source: string;
  className?: string;
  eventName?: string;
}) => {
  const [level, setLevel] = useState(0);
  const decayRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    listen<LevelPayload>(eventName, (e) => {
      if (e.payload.source === source) setLevel(e.payload.level);
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [eventName, source]);

  // Smoothly decay toward 0 when events stop arriving.
  useEffect(() => {
    decayRef.current = setInterval(() => setLevel((l) => (l > 0.001 ? l * 0.6 : 0)), 120);
    return () => {
      if (decayRef.current) clearInterval(decayRef.current);
    };
  }, []);

  const pct = Math.min(100, Math.round(Math.sqrt(level) * 100));
  // Green = receiving you, red = clipping (too hot). Amber is deliberately NOT
  // used here so it reads only as "delivery worth a look" in the DeliveryPanel —
  // one consistent colour language across the meters instead of amber-means-three-
  // things (loud vs. too-fast vs. too-flat).
  const color = pct > 92 ? "bg-red-500" : pct > 3 ? "bg-emerald-500" : "bg-muted-foreground/30";

  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-muted ${className ?? "w-16"}`}>
      <div
        className={`h-full rounded-full transition-[width] duration-75 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};
