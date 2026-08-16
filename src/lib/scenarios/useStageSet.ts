import { useEffect, useMemo, useState } from "react";
import { useI18n, type TranslationKey } from "../../i18n";
import {
  buildScenarioSet,
  buildStageSet,
  readStageBundleFile,
  type ScenarioSet,
  type StageSet,
} from "./bundles";
import { EMPTY_BUNDLE_FILE, type ParsedBundleFile } from "./bundleFile";

function useBundleFile(): ParsedBundleFile {
  const [parsed, setParsed] = useState<ParsedBundleFile>(EMPTY_BUNDLE_FILE);
  useEffect(() => {
    let alive = true;
    readStageBundleFile()
      .then((p) => {
        if (alive) setParsed(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return parsed;
}

/**
 * The SALES stage universe for UI components (#155): builtin five + custom
 * stages, overrides applied, display names resolved. The file read rides a
 * short module-level cache (bundles.ts), so per-row mounts are cheap.
 */
export function useStageSet(): StageSet {
  const { t } = useI18n();
  const parsed = useBundleFile();
  return useMemo(() => buildStageSet((k) => t(k as TranslationKey), parsed), [t, parsed]);
}

/** The scenario universe (v3): builtins + custom scenarios. */
export function useScenarioSet(): ScenarioSet {
  const { t } = useI18n();
  const parsed = useBundleFile();
  return useMemo(() => buildScenarioSet((k) => t(k as TranslationKey), parsed), [t, parsed]);
}
