import ParleyKit
import UIKit

/// The strip's transient chip slot and the saved-info panel.
///
/// Kept out of `KeyboardViewController` the way `KeyboardLexiconWatch` is, and
/// for the same reason: the controller is shared with several features changing
/// at once, and this one talks to it through a handful of one-line hooks —
/// `appeared`, `textChanged`, `selectionChanged`, `keyPressed`,
/// `dictationInserted` — and two insertion methods on the controller that put
/// text in the field the same way every other key does.
///
/// ## The strip slot
///
/// The wordmark's place on the strip holds at most one kind of chip, chosen in
/// this order:
///
/// 1. **「↩︎ 換回原文」** — the dictation that just landed was polished, and
///    the cursor is still right after it. One tap swaps the polish for what
///    was actually said.
/// 2. **Field chips** — the field asks for an email, a phone number, an address
///    or a name, and the user has saved one in 常用資訊.
///
/// The order is how perishable each is: the revert stops being possible the
/// moment the user types, and the field's kind lasts as long as the field.
///
/// ## No pasteboard reads
///
/// This keyboard does not read the pasteboard. 1.30 had a paste chip and a
/// clipboard history here; both went, because iOS gives a keyboard no
/// background access to the pasteboard and every read of another app's copy
/// shows a banner or a prompt — see `RetiredClipboard`. The only pasteboard
/// call left in the keyboard is the voice pane's tap-to-copy, which writes.
///
/// ## Off the keystroke path
///
/// `keyPressed` is the only hook a key reaches, and it is one `nil` check
/// unless the revert chip is up — in which case it takes the chip down, once.
/// The snippets are read from disk once per appearance, and only when a field
/// asks for one or the panel opens.
///
/// Without Full Access none of this exists: there is no App Group to read
/// 常用資訊 from. The strip button and every chip are hidden, and nothing else
/// about the keyboard changes.
final class KeyboardStripSlot {
    private let bridge: KeyboardBridge
    private weak var controller: KeyboardViewController?

    /// The polished dictation that just landed, while it can still be swapped.
    private var revert: RevertOffer?
    /// What the current field asks for, if it is something 常用資訊 can fill.
    private var field: SnippetField?
    /// The user took a field chip: no more suggestions for this field.
    private var fieldClosed = false
    /// The 常用資訊, read once per appearance and only when something needs
    /// them — a field that asks, or the panel opening. In memory only while the
    /// keyboard is up; `disappeared` drops them.
    private var snippets: [Snippet]?

    init(bridge: KeyboardBridge, controller: KeyboardViewController) {
        self.bridge = bridge
        self.controller = controller
    }

    private var hasFullAccess: Bool { controller?.hasFullAccess ?? false }
    private var proxy: UITextDocumentProxy? { controller?.textDocumentProxy }

    // MARK: hooks from the controller

    /// The keyboard is coming up: look at what the field asks for. Called
    /// before the downlink drain, which may put a revert chip straight back for
    /// a dictation that lands on this appearance.
    func appeared() {
        revert = nil
        snippets = nil
        fieldClosed = false
        guard hasFullAccess else {
            field = nil
            closePanel()
            publish()
            return
        }
        refreshField()
        publish()
    }

    /// The keyboard is going away. Everything held for it goes with it.
    func disappeared() {
        closePanel()
        snippets = nil
    }

    /// The host changed its text: a different field, an autofill, a tap. The
    /// revert is only safe while the cursor is right after the dictation, and
    /// the field may now ask for something else.
    func textChanged() {
        guard hasFullAccess else { return }
        checkRevert()
        let before = field
        refreshField()
        if field != before { fieldClosed = false }
        publish()
    }

    /// The cursor moved. Only the revert cares.
    func selectionChanged() {
        guard revert != nil else { return }
        checkRevert()
        publish()
    }

    /// A key on this keyboard typed or deleted something: the revert is over,
    /// because the text before the cursor is no longer only the dictation.
    /// Cheap when the chip is not up, which is almost every key.
    func keyPressed() {
        guard revert != nil else { return }
        revert = nil
        publish()
    }

    /// A dictation was just inserted. `raw` is what the app says the user
    /// actually said, when the polish changed it (`Downlink.revertibleRaw`).
    func dictationInserted(_ inserted: String, raw: String?) {
        revert = raw.flatMap { RevertOffer(inserted: inserted, raw: $0) }
        publish()
    }

    /// A new session: the revert is over.
    func sessionStarted() {
        guard revert != nil else { return }
        revert = nil
        publish()
    }

    /// The user moved to another pane: the revert is over, and the panel goes.
    func paneChanged() {
        revert = nil
        closePanel()
        publish()
    }

    // MARK: chip taps

    /// 「↩︎ 換回原文」. Checked once more against the field: swapping words that
    /// are not where the dictation left them would delete whatever is.
    func useOriginal() {
        guard let offer = revert else { return }
        revert = nil
        publish()
        guard offer.cursorIsAfterInsertion(context: proxy?.documentContextBeforeInput) else { return }
        controller?.replaceDictation(deleting: offer.deleteCount, with: offer.raw)
    }

    /// A field chip: insert that snippet, and stop suggesting for this field.
    func insertFieldSnippet(_ id: UUID) {
        guard let snippet = loadedSnippets().first(where: { $0.id == id }) else { return }
        fieldClosed = true
        publish()
        controller?.insertFromStrip(snippet.value)
    }

    // MARK: the panel

    func togglePanel() {
        if bridge.savedInfoPanel != nil { closePanel() } else { openPanel() }
    }

    /// The panel is handed the snippets with sensitive values already masked;
    /// the full values stay here, and a tap comes back by id.
    func openPanel() {
        guard hasFullAccess else { return }
        let content = SavedInfoPanelContent(
            snippets: loadedSnippets().map {
                SavedInfoPanelContent.Saved(
                    id: $0.id, kind: $0.kind, label: $0.label, text: $0.displayValue,
                    sensitive: $0.kind.isSensitive)
            })
        if bridge.savedInfoPanel != content { bridge.savedInfoPanel = content }
    }

    func closePanel() {
        if bridge.savedInfoPanel != nil { bridge.savedInfoPanel = nil }
    }

    /// A row: insert the full value, masked or not, and close the panel.
    func pickSnippet(_ id: UUID) {
        guard let snippet = loadedSnippets().first(where: { $0.id == id }) else { return }
        closePanel()
        controller?.insertFromStrip(snippet.value)
    }

    // MARK: internals

    private func checkRevert() {
        guard let offer = revert else { return }
        if !offer.cursorIsAfterInsertion(context: proxy?.documentContextBeforeInput) {
            revert = nil
        }
    }

    /// What the host field asks for, in 常用資訊's terms. The content type is
    /// the precise signal; the keyboard type is the fallback for fields that
    /// set only that.
    private func refreshField() {
        guard let proxy else {
            field = nil
            return
        }
        field = Self.field(contentType: proxy.textContentType, keyboardType: proxy.keyboardType)
    }

    static func field(contentType: UITextContentType?, keyboardType: UIKeyboardType?)
        -> SnippetField?
    {
        if let contentType {
            switch contentType {
            case .emailAddress:
                return .email
            case .fullStreetAddress, .streetAddressLine1, .streetAddressLine2, .addressCity,
                .postalCode:
                return .address
            case .name, .givenName, .familyName:
                return .name
            case .telephoneNumber:
                return .phone
            default:
                break
            }
        }
        switch keyboardType {
        case .emailAddress: return .email
        case .phonePad: return .phone
        default: return nil
        }
    }

    private func loadedSnippets() -> [Snippet] {
        if let snippets { return snippets }
        let loaded = SnippetStore.shared()?.load() ?? []
        snippets = loaded
        return loaded
    }

    /// The chip the strip shows, by the priority in the type's doc comment.
    /// Assigns only on a change: the bridge redraws the root on every publish.
    private func publish() {
        var next: KeyboardBridge.StripChip?
        if hasFullAccess {
            if revert != nil {
                next = .revert
            } else if let field, !fieldClosed {
                let chips = field.suggestions(from: loadedSnippets()).map {
                    KeyboardBridge.FieldChip(id: $0.id, kind: $0.kind, text: $0.displayValue)
                }
                if !chips.isEmpty { next = .fields(chips) }
            }
        }
        if bridge.stripChip != next { bridge.stripChip = next }
    }
}

/// What the saved-info panel draws, as one value — see `SavedInfoPanel`. The
/// panel never holds an unmasked sensitive value.
struct SavedInfoPanelContent: Equatable {
    struct Saved: Equatable, Identifiable {
        var id: UUID
        var kind: SnippetKind
        var label: String
        /// The value as drawn: masked for a sensitive kind.
        var text: String
        var sensitive: Bool
    }

    var snippets: [Saved]
}
