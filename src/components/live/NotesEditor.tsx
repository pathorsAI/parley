import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Heading, Italic, List, ListOrdered, ListTodo, Strikethrough } from "lucide-react";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { normalizeNotesMarkdown } from "../../lib/meeting/notesMarkdown";
import { notesExtensions } from "../../lib/meeting/notesSchema";

/**
 * Tab and ⇧Tab nest and un-nest list items (ListItem / TaskItem bind them).
 * When they can't — the first item can't go deeper — the key is still the
 * list's: without this the browser would move focus out of the notes.
 * Low priority so the list items' own bindings run first.
 */
const ListTabGuard = Extension.create({
  name: "notesListTabGuard",
  priority: 50,
  addKeyboardShortcuts() {
    const inList = () => this.editor.isActive("listItem") || this.editor.isActive("taskItem");
    return { Tab: inList, "Shift-Tab": inList };
  },
});

/** The bubble menu floats over everything: it is put on <body> (the mini
 *  window's box is short and scrolls) and placed with `fixed`. Module-level so
 *  the menu doesn't re-send its options on every render. */
const appendToBody = () => document.body;
const BUBBLE_OPTIONS = { strategy: "fixed", placement: "top", offset: 6, flip: true, shift: { padding: 6 } } as const;

/**
 * The in-meeting notes: a small Notion-like editor whose value is Markdown —
 * the store's `meetingNotes` string. Markdown shortcuts as you type (`- `,
 * `1. `, `[] `, `# `, `> `, `**bold**`…), and a formatting bubble over a
 * selection. `compact` is the mini window's box.
 *
 * The notes are mirrored between the meeting window and the main window
 * (lib/meeting/meetingWindow.ts), so the value can change under the editor.
 * The editor remembers the Markdown it last wrote; a store value that differs
 * from that came from elsewhere and replaces the content (without emitting an
 * update, so it doesn't echo back). Its own typing round-trips to the same
 * string and leaves the editor — and the caret — alone.
 */
export function NotesEditor({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { t } = useI18n();
  const notes = useStore((s) => s.meetingNotes);
  const setNotes = useStore((s) => s.setMeetingNotes);
  /** The Markdown this editor last wrote to the store (or loaded from it). */
  const lastMarkdown = useRef(notes);
  const placeholder = useRef(t("floating.notesPlaceholder"));
  placeholder.current = t("floating.notesPlaceholder");

  // Stable options: useEditor compares them on every render and re-applies
  // any that changed. The content is only the starting value; later values
  // arrive through the effect below.
  const [initial] = useState(notes);
  const extensions = useMemo(
    () => notesExtensions([ListTabGuard, Placeholder.configure({ placeholder: () => placeholder.current })]),
    [],
  );
  const label = t("floating.tabs.notes");
  const editorProps = useMemo(
    () => ({
      attributes: {
        class: `notes-editor min-h-full select-text text-sm leading-[22px] text-foreground outline-none ${
          compact ? "px-3 py-2" : "p-5"
        }`,
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
      },
    }),
    [compact, label],
  );

  const editor = useEditor({
    extensions,
    content: initial,
    contentType: "markdown",
    editorProps,
    onUpdate: ({ editor: e }) => {
      const markdown = normalizeNotesMarkdown(e.getMarkdown());
      if (markdown === lastMarkdown.current) return;
      lastMarkdown.current = markdown;
      setNotes(markdown);
    },
  });

  // A value from elsewhere (the other window, a reset when the meeting ends).
  useEffect(() => {
    if (!editor || editor.isDestroyed || notes === lastMarkdown.current) return;
    lastMarkdown.current = notes;
    editor.commands.setContent(notes, { contentType: "markdown", emitUpdate: false });
  }, [editor, notes]);

  // The language can change while the editor is up: redraw the placeholder
  // (a decoration, so it only re-reads its text on a transaction).
  const placeholderText = placeholder.current;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor, placeholderText]);

  return (
    // data-no-drag: a press anywhere in the notes (its padding, the
    // scrollbar) selects text instead of dragging the window.
    <div
      data-no-drag
      className={compact ? "min-h-0 w-full flex-1 overflow-y-auto" : "size-full overflow-y-auto"}
      // A click below the last line still puts the caret at the end.
      onMouseDown={(e) => {
        if (editor && e.target === e.currentTarget) {
          e.preventDefault();
          editor.commands.focus("end");
        }
      }}
    >
      <EditorContent editor={editor} className="h-full" />
      {editor && <FormatBubble editor={editor} />}
    </div>
  );
}

type FormatKey = "bold" | "italic" | "strike" | "heading" | "bulletList" | "orderedList" | "taskList";

const FORMATS: { key: FormatKey; icon: ComponentType<{ className?: string }>; run: (e: Editor) => void }[] = [
  { key: "bold", icon: Bold, run: (e) => e.chain().focus().toggleBold().run() },
  { key: "italic", icon: Italic, run: (e) => e.chain().focus().toggleItalic().run() },
  { key: "strike", icon: Strikethrough, run: (e) => e.chain().focus().toggleStrike().run() },
  {
    key: "heading",
    icon: Heading,
    run: (e) =>
      e.isActive("heading")
        ? e.chain().focus().setParagraph().run()
        : e.chain().focus().setHeading({ level: 2 }).run(),
  },
  { key: "bulletList", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: "orderedList", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: "taskList", icon: ListTodo, run: (e) => e.chain().focus().toggleTaskList().run() },
];

/** Bold … task list, over a non-empty selection. */
function FormatBubble({ editor }: Readonly<{ editor: Editor }>) {
  const { t } = useI18n();
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      Object.fromEntries(FORMATS.map(({ key }) => [key, e.isActive(key)])) as Record<FormatKey, boolean>,
  });

  return (
    <BubbleMenu
      editor={editor}
      appendTo={appendToBody}
      options={BUBBLE_OPTIONS}
      data-no-drag=""
      className="z-50"
    >
      <div
        role="toolbar"
        aria-label={t("notes.format.label")}
        className="flex items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
      >
        {FORMATS.map(({ key, icon: Icon, run }, i) => {
          const label = t(`notes.format.${key}`);
          const on = active[key];
          return (
            <span key={key} className="flex items-center">
              {/* A hairline between the inline marks and the blocks. */}
              {i === 3 && <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />}
              <button
                type="button"
                aria-label={label}
                aria-pressed={on}
                title={label}
                // Keep the selection: the button must not take focus.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(editor)}
                className={`grid size-7 place-items-center rounded transition-colors ${
                  on ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-muted"
                }`}
              >
                <Icon className="size-3.5" />
              </button>
            </span>
          );
        })}
      </div>
    </BubbleMenu>
  );
}
