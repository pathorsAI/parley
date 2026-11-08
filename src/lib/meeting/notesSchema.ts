// The rich-text notes editor's schema: which Tiptap extensions it runs, shared
// by the editor component and the Markdown round-trip tests. No React, no DOM —
// building the extensions and serialising through MarkdownManager both run in
// plain Node.

import { Extension, InputRule, type AnyExtension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";

/**
 * `- ` turns a line into a bullet before the user can finish typing GitHub's
 * `- [ ] `, so the `[ ] ` then lands inside a bullet. When that bullet is a
 * list of its own (one item, one paragraph), it becomes a task list instead.
 * Anywhere else the rule steps aside (returns null) for TaskItem's own.
 */
const BulletToTask = Extension.create({
  name: "notesBulletToTask",
  // Ahead of TaskItem's wrapping rule, which would nest a task list inside
  // the bullet.
  priority: 200,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX])?\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.depth < 3) return null;
          const item = $from.node(-1);
          const list = $from.node(-2);
          if (item.type.name !== "listItem" || list.type.name !== "bulletList") return null;
          if (list.childCount !== 1 || item.childCount !== 1) return null;
          const { taskList, taskItem } = state.schema.nodes;
          if (!taskList || !taskItem) return null;
          const checked = (match[1] ?? " ").toLowerCase() === "x";
          chain()
            .deleteRange(range)
            .command(({ tr }) => {
              const $p = tr.selection.$from;
              const listPos = $p.before(-2);
              const oldList = tr.doc.nodeAt(listPos);
              if (!oldList) return false;
              const content = oldList.child(0).content;
              tr.replaceWith(listPos, listPos + oldList.nodeSize, taskList.create(null, taskItem.create({ checked }, content)));
              // taskList > taskItem > paragraph: three steps in.
              tr.setSelection(TextSelection.create(tr.doc, listPos + 3));
              return true;
            })
            .run();
        },
      }),
    ];
  },
});

/** ⌘⇧X strikes through too (Tiptap's own is ⌘⇧S), the chord Notion and
 *  Google Docs use. */
const StrikeChord = Extension.create({
  name: "notesStrikeChord",
  addKeyboardShortcuts() {
    return { "Mod-Shift-x": () => this.editor.commands.toggleStrike() };
  },
});

/** Everything the notes editor understands, all of it with a Markdown form. */
export function notesExtensions(extra: AnyExtension[] = []): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // No Markdown form (underline), or behaviour a scratch pad doesn't want
      // (links that open on click, a forced empty paragraph after a list).
      underline: false,
      link: false,
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    BulletToTask,
    StrikeChord,
    Markdown,
    ...extra,
  ];
}
