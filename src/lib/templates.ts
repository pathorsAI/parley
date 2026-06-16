/**
 * Reconcile built-in templates with whatever was loaded from disk / persisted
 * state. Built-in templates always come fresh from the presets (so new ones
 * ship to existing users and old ones stay up to date), while the user's own
 * custom templates are preserved.
 */
export function reconcileTemplates<T extends { id: string; builtin?: boolean }>(
  presets: T[],
  loaded: T[]
): T[] {
  const presetIds = new Set(presets.map((t) => t.id));
  const customs = loaded.filter((t) => !t.builtin && !presetIds.has(t.id));
  return [...presets, ...customs];
}
