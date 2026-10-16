import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import { log } from "../log";
import {
  LOCAL_STT_PROGRESS_EVENT,
  cancelLocalSttDownload,
  deleteLocalSttModel,
  downloadLocalSttModel,
  fetchLocalSttModels,
  reduceLocalProgress,
  type LocalDownloads,
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
  refresh: () => void;
  download: (modelId: string) => void;
  cancel: (modelId: string) => void;
  remove: (modelId: string) => Promise<void>;
}

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

  return { models, downloads, loadError, refresh, download, cancel, remove };
}
