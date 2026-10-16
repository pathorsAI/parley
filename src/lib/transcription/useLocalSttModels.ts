import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import { log } from "../log";
import {
  LOCAL_STT_PROGRESS_EVENT,
  cancelLocalSttDownload,
  deleteLocalSttModel,
  downloadLocalSttModel,
  fetchLocalSttHardware,
  fetchLocalSttModels,
  reduceLocalProgress,
  type LocalDownloads,
  type LocalSttHardware,
  type LocalSttModel,
  type LocalSttProgress,
} from "./localModels";

export interface LocalSttModelsState {
  /** null while the catalog is loading (or when the command failed). */
  models: LocalSttModel[] | null;
  /** Per-model download state; absent = idle. */
  downloads: LocalDownloads;
  /** The catalog call failed (backend missing or errored). */
  loadError: string | null;
  /** This machine (RAM, free disk, acceleration, recommended model); `null`
   *  until read, or when it could not be read — then fit is unknown and the
   *  picker shows no fit badges and blocks nothing. */
  hardware: LocalSttHardware | null;
  refresh: () => void;
  download: (modelId: string) => void;
  cancel: (modelId: string) => void;
  remove: (modelId: string) => Promise<void>;
}

/** The last hardware report any picker read, so a picker opened later shows
 *  fit at once (the fresh read then replaces it). Total RAM, cores and
 *  acceleration never change; free disk and available memory do, which is why
 *  it is read again on every refresh. */
let cachedHardware: LocalSttHardware | null = null;

/**
 * The local-model catalog plus live download state, shared by Settings and
 * Onboarding. Subscribes to `local-stt://progress` (Tauri broadcasts it to every
 * window, so a download started in Settings also moves onboarding's bar) and
 * re-reads the catalog whenever a download settles. Pass `enabled = false` to
 * keep it idle while the local provider isn't selected.
 */
export function useLocalSttModels(enabled = true): LocalSttModelsState {
  const [models, setModels] = useState<LocalSttModel[] | null>(null);
  const [downloads, setDownloads] = useState<LocalDownloads>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hardware, setHardware] = useState<LocalSttHardware | null>(cachedHardware);
  // Cancels the user asked for: the download promise rejects when cancelled,
  // and that rejection must read as "cancelled", not as an error.
  const cancelRequested = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    fetchLocalSttModels()
      .then((list) => {
        if (!alive.current) return;
        setModels(list);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive.current) return;
        log.warn("local-stt: catalog load failed", { error: String(e) });
        setModels(null);
        setLoadError(String(e));
      });
    // Read alongside the catalog: on open, and whenever a download settles
    // (free disk moved). The catalog's per-model `fit` is computed by the
    // backend from the same probe; this is for the numbers and the
    // recommendation.
    fetchLocalSttHardware()
      .then((hw) => {
        cachedHardware = hw;
        if (alive.current) setHardware(hw);
      })
      .catch((e) => {
        log.warn("local-stt: hardware read failed", { error: String(e) });
        cachedHardware = null;
        if (alive.current) setHardware(null);
      });
  }, []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    listen<LocalSttProgress>(LOCAL_STT_PROGRESS_EVENT, (e) => {
      if (!live) return;
      const ev = e.payload;
      setDownloads((s) => reduceLocalProgress(s, ev));
      if (ev.stage === "done" || ev.stage === "error" || ev.stage === "cancelled") refresh();
    })
      .then((u) => {
        if (live) unlisten = u;
        else u();
      })
      .catch((error) => log.warn("local-stt: progress listen failed", { error: String(error) }));
    return () => {
      live = false;
      unlisten?.();
    };
  }, [enabled, refresh]);

  const download = useCallback(
    (modelId: string) => {
      cancelRequested.current.delete(modelId);
      setDownloads((s) => ({ ...s, [modelId]: { status: "downloading", received: 0, total: 0 } }));
      downloadLocalSttModel(modelId)
        .then(() => {
          if (!alive.current) return;
          setDownloads((s) => reduceLocalProgress(s, { modelId, stage: "done", received: 0, total: 0 }));
          refresh();
        })
        .catch((e) => {
          if (!alive.current) return;
          const cancelled = cancelRequested.current.has(modelId);
          cancelRequested.current.delete(modelId);
          if (!cancelled) log.warn("local-stt: download failed", { modelId, error: String(e) });
          setDownloads((s) =>
            reduceLocalProgress(s, {
              modelId,
              stage: cancelled ? "cancelled" : "error",
              received: 0,
              total: 0,
              message: e instanceof Error ? e.message : String(e),
            }),
          );
          refresh();
        });
    },
    [refresh],
  );

  const cancel = useCallback((modelId: string) => {
    cancelRequested.current.add(modelId);
    cancelLocalSttDownload(modelId).catch((error) =>
      log.warn("local-stt: cancel failed", { modelId, error: String(error) }),
    );
  }, []);

  const remove = useCallback(
    async (modelId: string) => {
      try {
        await deleteLocalSttModel(modelId);
      } finally {
        if (alive.current) {
          setDownloads((s) => reduceLocalProgress(s, { modelId, stage: "done", received: 0, total: 0 }));
          refresh();
        }
      }
    },
    [refresh],
  );

  return { models, downloads, loadError, hardware, refresh, download, cancel, remove };
}
