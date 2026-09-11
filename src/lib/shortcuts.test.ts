import { describe, expect, it } from "vitest";
import {
  activatesFocusedControl,
  isTypingTarget,
  matchShortcut,
  shortcutFires,
  type KeyStroke,
  type ShortcutSpec,
} from "./shortcuts";

/**
 * The two properties every global shortcut in the app leans on: a chord means
 * exactly one thing, and none of them fire while the user is typing.
 */

const MAC = true;
const PC = false;

/** A keystroke with nothing held down; override what the case is about. */
function stroke(overrides: Partial<KeyStroke> & { key: string }): KeyStroke {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

const cmdK: ShortcutSpec = { mod: true, key: "k" };

describe("matchShortcut", () => {
  it("maps mod to ⌘ on macOS and Ctrl elsewhere", () => {
    const meta = stroke({ key: "k", metaKey: true });
    const ctrl = stroke({ key: "k", ctrlKey: true });

    expect(matchShortcut(meta, cmdK, MAC)).toBe(true);
    expect(matchShortcut(ctrl, cmdK, MAC)).toBe(false);

    expect(matchShortcut(ctrl, cmdK, PC)).toBe(true);
    expect(matchShortcut(meta, cmdK, PC)).toBe(false);
  });

  it("treats mod as exclusive, so Ctrl+⌘ is a different chord", () => {
    const both = stroke({ key: "k", metaKey: true, ctrlKey: true });
    expect(matchShortcut(both, cmdK, MAC)).toBe(false);
    expect(matchShortcut(both, cmdK, PC)).toBe(false);
  });

  it("does not match a bare key when a modifier is held", () => {
    const spec: ShortcutSpec = { key: "k" };
    expect(matchShortcut(stroke({ key: "k" }), spec, MAC)).toBe(true);
    expect(matchShortcut(stroke({ key: "k", metaKey: true }), spec, MAC)).toBe(false);
    expect(matchShortcut(stroke({ key: "k", ctrlKey: true }), spec, MAC)).toBe(false);
  });

  it("matches shift and alt exactly, in both directions", () => {
    const shifted: ShortcutSpec = { mod: true, shift: true, key: "k" };
    expect(matchShortcut(stroke({ key: "k", metaKey: true, shiftKey: true }), shifted, MAC)).toBe(
      true
    );
    // ⌘K is not ⇧⌘K…
    expect(matchShortcut(stroke({ key: "k", metaKey: true }), shifted, MAC)).toBe(false);
    // …and ⇧⌘K is not ⌘K either.
    expect(matchShortcut(stroke({ key: "k", metaKey: true, shiftKey: true }), cmdK, MAC)).toBe(
      false
    );
    expect(matchShortcut(stroke({ key: "k", metaKey: true, altKey: true }), cmdK, MAC)).toBe(false);
  });

  it("compares the key case-insensitively and by name", () => {
    expect(matchShortcut(stroke({ key: "K", metaKey: true }), cmdK, MAC)).toBe(true);
    expect(matchShortcut(stroke({ key: "j", metaKey: true }), cmdK, MAC)).toBe(false);

    const back: ShortcutSpec = { mod: true, key: "ArrowLeft" };
    expect(matchShortcut(stroke({ key: "ArrowLeft", metaKey: true }), back, MAC)).toBe(true);
    expect(matchShortcut(stroke({ key: "ArrowRight", metaKey: true }), back, MAC)).toBe(false);

    const bracket: ShortcutSpec = { mod: true, key: "[" };
    expect(matchShortcut(stroke({ key: "[", metaKey: true }), bracket, MAC)).toBe(true);
    expect(matchShortcut(stroke({ key: "]", metaKey: true }), bracket, MAC)).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("claims the keyboard for text fields", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    // Lowercase can't happen in HTML, but an SVG-ish or synthetic target can.
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
  });

  it("claims it for anything inside a contenteditable region", () => {
    // isContentEditable is inherited, so a nested node answers true as well.
    expect(isTypingTarget({ tagName: "B", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("leaves ordinary elements — and no target at all — to the shortcuts", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget(globalThis)).toBe(false);
  });
});

describe("activatesFocusedControl", () => {
  const space: ShortcutSpec = { key: " " };

  it("leaves Space to a button that already has focus", () => {
    expect(activatesFocusedControl({ ...stroke({ key: " " }), target: { tagName: "BUTTON" } })).toBe(
      true
    );
    expect(
      activatesFocusedControl({ ...stroke({ key: "Enter" }), target: { tagName: "BUTTON" } })
    ).toBe(true);
    // Links and disclosure triangles answer to the same keys.
    expect(activatesFocusedControl({ ...stroke({ key: "Enter" }), target: { tagName: "A" } })).toBe(
      true
    );
    expect(
      activatesFocusedControl({ ...stroke({ key: " " }), target: { tagName: "SUMMARY" } })
    ).toBe(true);
  });

  it("keeps out of the way of everything else", () => {
    // Not an activation key…
    expect(activatesFocusedControl({ ...stroke({ key: "k" }), target: { tagName: "BUTTON" } })).toBe(
      false
    );
    // …not an activatable element…
    expect(activatesFocusedControl({ ...stroke({ key: " " }), target: { tagName: "DIV" } })).toBe(
      false
    );
    expect(activatesFocusedControl({ ...stroke({ key: " " }) })).toBe(false);
    // …and a modifier means the button is not being activated at all, so ⌘↩ on
    // a focused button is still ours.
    expect(
      activatesFocusedControl({
        ...stroke({ key: "Enter", metaKey: true }),
        target: { tagName: "BUTTON" },
      })
    ).toBe(false);
  });

  it("stops Space from toggling a recording twice", () => {
    // The bug: click play with the mouse, focus stays on the button, and the
    // next Space both activates it and fires the shortcut.
    const onButton = { ...stroke({ key: " " }), target: { tagName: "BUTTON" } };
    const onPage = { ...stroke({ key: " " }), target: { tagName: "DIV" } };
    expect(shortcutFires(onPage, space, {}, MAC)).toBe(true);
    expect(shortcutFires(onButton, space, {}, MAC)).toBe(false);
    // Not a typing question, so `whileTyping` does not opt back out of it.
    expect(shortcutFires(onButton, space, { whileTyping: true }, MAC)).toBe(false);
  });

  it("counts ⇧Space, which activates a button just the same", () => {
    const shifted = { ...stroke({ key: " ", shiftKey: true }), target: { tagName: "BUTTON" } };
    expect(activatesFocusedControl(shifted)).toBe(true);
  });
});

describe("shortcutFires", () => {
  const inField = { ...stroke({ key: "k", metaKey: true }), target: { tagName: "INPUT" } };
  const onPage = { ...stroke({ key: "k", metaKey: true }), target: { tagName: "DIV" } };

  it("swallows a matching chord while the caret is in a field", () => {
    expect(shortcutFires(onPage, cmdK, {}, MAC)).toBe(true);
    expect(shortcutFires(inField, cmdK, {}, MAC)).toBe(false);
  });

  it("honours the opt-out for shortcuts that own the field they fire in", () => {
    // ⌘K is the palette's own toggle: it must still close a palette whose
    // search input has focus.
    expect(shortcutFires(inField, cmdK, { whileTyping: true }, MAC)).toBe(true);
  });

  it("still requires the chord to match, opt-out or not", () => {
    const other = { ...stroke({ key: "j", metaKey: true }), target: { tagName: "INPUT" } };
    expect(shortcutFires(other, cmdK, { whileTyping: true }, MAC)).toBe(false);
  });

  it("suppresses inside a contenteditable, where a bare key is text", () => {
    const editing = {
      ...stroke({ key: "ArrowLeft", metaKey: true }),
      target: { tagName: "SPAN", isContentEditable: true },
    };
    // ⌘← is "jump to the start of the line" here, not "go back".
    expect(shortcutFires(editing, { mod: true, key: "ArrowLeft" }, {}, MAC)).toBe(false);
  });
});

describe("focus guards distinguish inputs by type", () => {
  const range = { tagName: "INPUT", type: "range" };
  const text = { tagName: "INPUT", type: "text" };
  const untyped = { tagName: "INPUT" };
  const checkbox = { tagName: "INPUT", type: "checkbox" };

  it("does not treat a slider or a checkbox as somewhere you are typing", () => {
    expect(isTypingTarget(range)).toBe(false);
    expect(isTypingTarget(checkbox)).toBe(false);
  });

  it("still treats a text input — declared or defaulted — as typing", () => {
    // An <input> with no type attribute is a text field per HTML, and losing
    // that would let a global chord fire mid-word in half the app's forms.
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(untyped)).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
  });

  it("lets Space through to play/pause while the scrubber has focus", () => {
    // The papercut this whole distinction exists for: click the scrubber with
    // the mouse, press Space, and the recording must play. Before, the slider
    // counted as a typing target and swallowed it — while doing nothing with
    // Space itself, so the key was simply dead.
    const stroke = { key: " ", target: range };
    expect(activatesFocusedControl(stroke)).toBe(false);
    expect(shortcutFires(stroke, { key: " " }, {}, true)).toBe(true);
  });

  it("leaves the arrows to the slider, shifted or not", () => {
    // The other half: bare ← must NOT seek twice — once from the slider's own
    // handler and once from the global replay binding.
    expect(activatesFocusedControl({ key: "ArrowLeft", target: range })).toBe(true);
    expect(activatesFocusedControl({ key: "ArrowLeft", shiftKey: true, target: range })).toBe(true);
    expect(shortcutFires({ key: "ArrowLeft", target: range }, { key: "ArrowLeft" }, {}, true)).toBe(
      false
    );
    // ⌘← is a different chord that the slider has no claim on, so it navigates.
    expect(activatesFocusedControl({ key: "ArrowLeft", metaKey: true, target: range })).toBe(false);
  });

  it("keeps Space and Enter on a focused checkbox", () => {
    expect(activatesFocusedControl({ key: " ", target: checkbox })).toBe(true);
    expect(activatesFocusedControl({ key: " ", target: text })).toBe(false);
  });
});
