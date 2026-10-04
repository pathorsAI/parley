import ParleyKit
import UIKit

/// The strip's transient chips and the 📋 panel: everything this keyboard does
/// with the pasteboard, the clipboard history and the user's 常用資訊.
///
/// Kept out of `KeyboardViewController` the way `KeyboardLexiconWatch` is, and
/// for the same reason: the controller is shared with several features changing
/// at once, and this one talks to it through a handful of one-line hooks —
/// `appeared`, `textChanged`, `selectionChanged`, `keyPressed`,
/// `dictationInserted` — and three insertion methods on the controller that put
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
/// 2. **「📋 貼上」** — something new was copied in another app. One tap pastes
///    it.
/// 3. **Field chips** — the field asks for an email, a phone number, an address
///    or a name, and the user has saved one in 常用資訊.
///
/// The order is how perishable each is: the revert stops being possible the
/// moment the user types, the paste offer lasts three minutes, and the field's
/// kind lasts as long as the field.
///
/// ## The pasteboard: nothing is read without intent
///
/// Deciding whether to offer a paste reads only `changeCount`, `hasStrings`,
/// `hasURLs` and `types` — none of which iOS counts as reading the pasteboard,
/// so none of them shows the paste banner or the 「允許貼上」 prompt. The
/// contents are read in exactly three cases: the user tapped the paste chip;
/// the user turned on 「在狀態列預覽剪貼簿內容」 (the chip's label); the user
/// turned on 「自動收錄剪貼簿」 (the history). Both settings are off until the
/// user turns them on in Parley, which is also where they are told to set iOS's
/// 「從其他 App 貼上」 to 允許 first.
///
/// A pasteboard carrying a password manager's concealed marker is never read
/// for a preview and never stored; the chip can still paste it, because that is
/// what it was copied for.
///
/// ## Off the keystroke path
///
/// `keyPressed` is the only hook a key reaches, and it is a few `nil` checks
/// unless a chip is up — in which case it takes the chip down, once. The
/// pasteboard is looked at when the keyboard appears and when the strip comes
/// back to rest, never per key. The panel's lists are read from disk when it
/// opens and dropped when it closes.
///
/// Without Full Access none of this exists: there is no App Group to keep
/// anything in, and the pasteboard is not the keyboard's to read. The 📋 button
/// and every chip are hidden, and nothing else about the keyboard changes.
final class KeyboardClipboard {
    private let bridge: KeyboardBridge
    private weak var controller: KeyboardViewController?

    /// The polished dictation that just landed, while it can still be swapped.
    private var revert: RevertOffer?
    /// The copy being offered, while it is.
    private var paste: PasteOffer?
    private var pasteLabel = PasteChipLabel.text
    /// Takes the paste chip down at `PasteOffer.lifetime`.
    private var pasteExpiry: Task<Void, Never>?
    /// What the current field asks for, if it is something 常用資訊 can fill.
    private var field: SnippetField?
    /// The user took a field chip: no more suggestions for this field.
    private var fieldClosed = false
    /// The 常用資訊, read once per appearance and only when something needs
    /// them — a field that asks, or the panel opening. In memory only while the
    /// keyboard is up; `disappeared` drops them.
    private var snippets: [Snippet]?
    /// The history as the panel last showed it, so a tap inserts the full text
    /// rather than the shortened one the row drew. `nil` while the panel is
    /// closed.
    private var history: ClipboardHistory?

    init(bridge: KeyboardBridge, controller: KeyboardViewController) {
        self.bridge = bridge
        self.controller = controller
    }

    private var hasFullAccess: Bool { controller?.hasFullAccess ?? false }
    private var proxy: UITextDocumentProxy? { controller?.textDocumentProxy }

    // MARK: hooks from the controller

    /// The keyboard is coming up: look at the pasteboard (its counter, and its
    /// contents only where the user opted in), and at what the field asks for.
    /// Called before the downlink drain, which may put a revert chip straight
    /// back for a dictation that lands on this appearance.
    func appeared() {
        revert = nil
        snippets = nil
        fieldClosed = false
        guard hasFullAccess else {
            paste = nil
            field = nil
            closePanel()
            publish()
            return
        }
        let board = UIPasteboard.general
        autoCaptureIfOn(board)
        checkPasteboard(board)
        refreshField()
        publish()
    }

    /// The keyboard is going away. Everything held for it goes with it.
    func disappeared() {
        closePanel()
        snippets = nil
        pasteExpiry?.cancel()
        pasteExpiry = nil
    }

    /// The strip is showing its resting face again — `StripHome` appeared after
    /// a 注音 composition or an English word let go of it. A copy made while
    /// the keyboard was up (from a long-press menu in the host, say) is noticed
    /// here rather than at the next appearance.
    func stripAtRest() {
        guard hasFullAccess else { return }
        checkPasteboard(UIPasteboard.general)
        publish()
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

    /// A key on this keyboard typed or deleted something. The revert is over —
    /// the text after the cursor is no longer only the dictation — and the
    /// paste offer is declined. Cheap when neither is up, which is almost
    /// every key.
    func keyPressed() {
        var changed = false
        if revert != nil {
            revert = nil
            changed = true
        }
        if let paste {
            closePaste(paste)
            changed = true
        }
        if changed { publish() }
    }

    /// A dictation was just inserted. `raw` is what the app says the user
    /// actually said, when the polish changed it (`Downlink.revertibleRaw`).
    func dictationInserted(_ inserted: String, raw: String?) {
        revert = raw.flatMap { RevertOffer(inserted: inserted, raw: $0) }
        publish()
    }

    /// A new session, or the user moved to another pane: the revert is over.
    func sessionStarted() {
        guard revert != nil else { return }
        revert = nil
        publish()
    }

    func paneChanged() {
        revert = nil
        closePanel()
        publish()
    }

    /// Parley itself just wrote the pasteboard (the voice pane's tap-to-copy):
    /// that copy is not one to offer back.
    func noteOwnWrite() {
        ClipboardSettings.noteOwnWrite(changeCount: UIPasteboard.general.changeCount)
        if paste != nil {
            paste = nil
            pasteExpiry?.cancel()
            publish()
        }
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

    /// 「📋 貼上」: the one read of the pasteboard a user asks for by tapping.
    /// Inserted with `insertText` like any other key, and kept in the history
    /// whatever 「自動收錄剪貼簿」 says — a paste is the user choosing this text.
    func pasteFromPasteboard() {
        guard hasFullAccess else { return }
        if let paste { closePaste(paste) }
        publish()
        let board = UIPasteboard.general
        let types = board.types
        guard let text = board.string ?? board.url?.absoluteString, !text.isEmpty else { return }
        controller?.insertFromStrip(text)
        ClipboardSettings.setLastCapturedChangeCount(board.changeCount)
        ClipboardHistoryStore.shared()?.capture(text, types: types, blocked: sensitiveValues())
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
        if bridge.clipboardPanel != nil { closePanel() } else { openPanel() }
    }

    func openPanel() {
        guard hasFullAccess else { return }
        history = ClipboardHistoryStore.shared()?.load() ?? ClipboardHistory()
        publishPanel()
    }

    func closePanel() {
        history = nil
        if bridge.clipboardPanel != nil { bridge.clipboardPanel = nil }
    }

    /// A clipboard row: insert it — never through the system pasteboard — and
    /// close the panel.
    func pickClip(_ id: UUID) {
        guard let text = history?.items.first(where: { $0.id == id })?.text else { return }
        closePanel()
        controller?.insertFromStrip(text)
    }

    /// A 常用 row: insert the full value, masked or not, and close the panel.
    func pickSnippet(_ id: UUID) {
        guard let snippet = loadedSnippets().first(where: { $0.id == id }) else { return }
        closePanel()
        controller?.insertFromStrip(snippet.value)
    }

    func setPinned(_ id: UUID, _ pinned: Bool) {
        guard let store = ClipboardHistoryStore.shared() else { return }
        history = store.setPinned(id, pinned)
        publishPanel()
    }

    func deleteClip(_ id: UUID) {
        guard let store = ClipboardHistoryStore.shared() else { return }
        history = store.remove(id)
        publishPanel()
    }

    /// 「存成常用資訊」: a copied phone number, address or email becomes a
    /// snippet of the kind the user picked, labelled with the kind's name. It is
    /// edited further in the app, which is where 常用資訊 are managed.
    func saveClip(_ id: UUID, as kind: SnippetKind) {
        guard !kind.isSensitive,
            let text = history?.items.first(where: { $0.id == id })?.text,
            let store = SnippetStore.shared()
        else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        snippets = store.add(Snippet(kind: kind, label: kind.displayName, value: value))
        refreshField()
        publish()
        publishPanel()
    }

    // MARK: internals

    /// The paste chip, decided from the pasteboard's counter alone — see
    /// `PasteOffer.evaluate`. The label may read the contents, and only when
    /// the user turned the preview on.
    private func checkPasteboard(_ board: UIPasteboard) {
        let remembered = ClipboardSettings.pasteOffer()
        let now = Date()
        let (offer, shows) = PasteOffer.evaluate(
            changeCount: board.changeCount, hasText: board.hasStrings || board.hasURLs,
            remembered: remembered, now: now)
        if offer != remembered { ClipboardSettings.setPasteOffer(offer) }
        guard shows else {
            paste = nil
            pasteExpiry?.cancel()
            return
        }
        // Labelled once per copy: the label is about what was copied, and the
        // copy cannot change without the counter moving.
        if paste?.changeCount != offer.changeCount { pasteLabel = label(for: board) }
        paste = offer
        armExpiry(at: offer.expiresAt)
    }

    private func label(for board: UIPasteboard) -> PasteChipLabel {
        var preview: String?
        if ClipboardSettings.previewInStrip(), !ClipboardRules.isConcealed(types: board.types) {
            preview = board.string ?? board.url?.absoluteString
        }
        return PasteChipLabel.make(hasURL: board.hasURLs, previewText: preview)
    }

    /// 「自動收錄剪貼簿」: keep what is on the pasteboard, once per copy. Never
    /// reads a concealed pasteboard at all.
    private func autoCaptureIfOn(_ board: UIPasteboard) {
        guard ClipboardSettings.autoCapture() else { return }
        let count = board.changeCount
        guard ClipboardSettings.lastCapturedChangeCount() != count else { return }
        ClipboardSettings.setLastCapturedChangeCount(count)
        guard board.hasStrings || board.hasURLs else { return }
        let types = board.types
        guard !ClipboardRules.isConcealed(types: types),
            let text = board.string ?? board.url?.absoluteString
        else { return }
        ClipboardHistoryStore.shared()?.capture(text, types: types, blocked: sensitiveValues())
    }

    private func armExpiry(at deadline: Date) {
        pasteExpiry?.cancel()
        let wait = max(deadline.timeIntervalSinceNow, 0)
        pasteExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.paste = nil
            self.publish()
        }
    }

    private func closePaste(_ offer: PasteOffer) {
        ClipboardSettings.setPasteOffer(offer.closing)
        paste = nil
        pasteExpiry?.cancel()
        pasteExpiry = nil
    }

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

    private func sensitiveValues() -> Set<String> {
        SnippetStore.sensitiveValues(in: loadedSnippets())
    }

    /// The chip the strip shows, by the priority in the type's doc comment.
    /// Assigns only on a change: the bridge redraws the root on every publish.
    private func publish() {
        var next: KeyboardBridge.StripChip?
        if hasFullAccess {
            if revert != nil {
                next = .revert
            } else if paste != nil {
                next = .paste(pasteLabel)
            } else if let field, !fieldClosed {
                let chips = field.suggestions(from: loadedSnippets()).map {
                    KeyboardBridge.FieldChip(id: $0.id, kind: $0.kind, text: $0.displayValue)
                }
                if !chips.isEmpty { next = .fields(chips) }
            }
        }
        if bridge.stripChip != next { bridge.stripChip = next }
    }

    /// Hand the panel what it draws: rows shortened to what two lines can show,
    /// whether each can be saved as 常用資訊, and the snippets with sensitive
    /// values already masked. The full texts stay here.
    private func publishPanel() {
        guard let history else { return }
        let rows = { (items: [ClipboardItem]) in
            items.map { item in
                ClipboardPanelContent.Clip(
                    id: item.id, text: String(item.text.prefix(Self.rowPreviewLength)),
                    capturedAt: item.capturedAt, pinned: item.pinned,
                    saveAs: SnippetDetector.field(for: item.text)?.kinds ?? [])
            }
        }
        let content = ClipboardPanelContent(
            pinned: rows(history.pinned), recent: rows(history.recent),
            snippets: loadedSnippets().map {
                ClipboardPanelContent.Saved(
                    id: $0.id, kind: $0.kind, label: $0.label, text: $0.displayValue,
                    sensitive: $0.kind.isSensitive)
            },
            autoCapture: ClipboardSettings.autoCapture())
        if bridge.clipboardPanel != content { bridge.clipboardPanel = content }
    }

    /// How much of an item a row is handed. Two lines at the panel's size is
    /// well under this on any phone; the rest is never laid out.
    private static let rowPreviewLength = 160
}

/// What the 📋 panel draws, as one value — see `ClipboardPanel`. Text only, and
/// already shortened: the panel never holds a full clipboard item or an
/// unmasked sensitive value.
struct ClipboardPanelContent: Equatable {
    struct Clip: Equatable, Identifiable {
        var id: UUID
        var text: String
        var capturedAt: Date
        var pinned: Bool
        /// The kinds 「存成常用資訊」 offers for this text — empty when it is
        /// not recognisably a phone number, an address or an email.
        var saveAs: [SnippetKind]
    }

    struct Saved: Equatable, Identifiable {
        var id: UUID
        var kind: SnippetKind
        var label: String
        /// The value as drawn: masked for a sensitive kind.
        var text: String
        var sensitive: Bool
    }

    var pinned: [Clip]
    var recent: [Clip]
    var snippets: [Saved]
    /// 「自動收錄剪貼簿」 — the empty clipboard tab says how to turn it on.
    var autoCapture: Bool
}
