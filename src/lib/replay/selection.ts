/**
 * Whether the user has highlighted text, as opposed to the collapsed caret a
 * plain click leaves behind. The replay transcript seeks on a line click, but a
 * drag that ends on the same line also fires `click` — this is how it tells the
 * two apart. Takes the Selection (or what little of it matters) so it can be
 * unit-tested without a DOM.
 */
export function isTextSelected(selection: Pick<Selection, "isCollapsed"> | null | undefined): boolean {
  return !!selection && !selection.isCollapsed;
}
