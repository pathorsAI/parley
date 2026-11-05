// Post-meeting action items split by WHICH SIDE does them — "us" (the user's
// own side) and "them" (the other party) — and the plain-text list each side's
// copy button puts on the clipboard, ready to paste into a team chat or LINE.
// Pure: the panel owns the store reads and the i18n.

import type { ActionItem, ActionItemSide } from "../types";

export interface ActionItemGroup {
  side: ActionItemSide;
  items: ActionItem[];
}

/**
 * The items as two groups, us first then them — or null when no item carries a
 * side (a recording analysed before sides existed, or one a phone analysed),
 * which renders as the old flat list. A side-less item in an otherwise sided
 * list goes with "us": the list is the user's own to-do first. A side with no
 * items is left out.
 */
export function groupActionItemsBySide(items: readonly ActionItem[]): ActionItemGroup[] | null {
  if (!items.some((a) => a.side)) return null;
  const us = items.filter((a) => a.side !== "them");
  const them = items.filter((a) => a.side === "them");
  const groups: ActionItemGroup[] = [];
  if (us.length) groups.push({ side: "us", items: us });
  if (them.length) groups.push({ side: "them", items: them });
  return groups;
}

/** The distinct owners of a group, in first-seen order, blanks dropped. */
export function distinctOwners(items: readonly ActionItem[]): string[] {
  const seen = new Set<string>();
  for (const a of items) {
    const owner = a.owner?.trim();
    if (owner) seen.add(owner);
  }
  return [...seen];
}

/**
 * The clipboard text for one side:
 *
 *   派斯科技 後續要做：
 *   1. 寄報價單（Kevin）
 *   2. 安排 demo
 *
 * `header` is the already-translated first line; `ownerSuffix` turns an owner
 * into the localized parenthetical. Items without an owner get none.
 */
export function actionItemsCopyText(
  header: string,
  items: readonly ActionItem[],
  ownerSuffix: (owner: string) => string,
): string {
  const lines = items.map((a, i) => {
    const owner = a.owner?.trim();
    return `${i + 1}. ${a.text.trim()}${owner ? ownerSuffix(owner) : ""}`;
  });
  return [header, ...lines].join("\n");
}
