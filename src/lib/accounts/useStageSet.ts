import { useEffect, useMemo, useState } from "react";
import { useI18n, type TranslationKey } from "../../i18n";
import { buildStageSet, readStageBundleFile, type StageSet } from "./bundles";
import { EMPTY_BUNDLE_FILE, type ParsedBundleFile } from "./bundleFile";

/**
 * The stage universe for UI components (#155): builtin six + user-defined
 * custom stages, overrides applied, display names resolved. The file read
 * rides a short module-level cache (bundles.ts), so per-row mounts are cheap.
 */
export function useStageSet(): StageSet {
  const { t } = useI18n();
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
  return useMemo(() => buildStageSet((k) => t(k as TranslationKey), parsed), [t, parsed]);
}
