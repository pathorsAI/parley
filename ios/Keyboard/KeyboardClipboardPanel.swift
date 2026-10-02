import ParleyKit
import SwiftUI

/// The 📋 panel: the clipboard history and the user's 常用資訊, over the key
/// area the way `CandidateGrid` is — the same 213pt the panes have, so opening
/// it never changes the keyboard's height, and the track is hidden underneath
/// rather than covered (the keyboard has no background of its own to cover it
/// with).
///
/// Two tabs:
///
/// - **剪貼簿** — 釘選 first, then 最近 with how long ago each was copied. A
///   tap inserts the text with `insertText` and closes the panel; the system
///   pasteboard is never touched. A long press opens a small menu: 釘選 /
///   取消釘選, 刪除, and 存成常用資訊 when the text is recognisably a phone
///   number, an address or an email (`SnippetDetector`).
/// - **常用** — the 常用資訊 the user saved in Parley, with the kind's icon,
///   its label and its value. 身分證字號 and 統一編號 are drawn masked; a tap
///   inserts the whole value.
///
/// The menu is drawn inside the panel rather than as a system context menu:
/// a keyboard extension's view is hosted in another process's window, and a
/// context menu's preview and platter are clipped to the keyboard's frame there.
///
/// Value-fed and `Equatable` like the panes: it does not observe the bridge,
/// which publishes on every keystroke and microphone reading. The lists are a
/// `LazyVStack`, so only the rows on screen are built, and each row was handed
/// at most `KeyboardClipboard.rowPreviewLength` characters.
struct ClipboardPanel: View, Equatable {
    /// Actions only — see `ZhuyinPane` for why it is not observed.
    let bridge: KeyboardBridge
    var content: ClipboardPanelContent
    var dark: Bool

    enum Tab: Hashable { case clipboard, saved }

    @State private var tab = Tab.clipboard
    /// The row whose long-press menu is open.
    @State private var menuFor: ClipboardPanelContent.Clip?
    /// The row whose 「存成常用資訊」 is choosing a kind.
    @State private var savingFor: ClipboardPanelContent.Clip?
    @Environment(\.openURL) private var openURL

    static func == (a: Self, b: Self) -> Bool {
        a.content == b.content && a.dark == b.dark
    }

    var body: some View {
        VStack(spacing: 6) {
            tabs
            Group {
                switch tab {
                case .clipboard: clipboardList
                case .saved: savedList
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .padding(.horizontal, KBMetrics.sideInset + 6)
        .padding(.top, 6)
        .padding(.bottom, KBMetrics.paneBottom)
        // A fully transparent point in a keyboard never receives the touch —
        // see `KeyboardRootView` — so the panel's empty space carries the same
        // sub-visible fill, or a scroll that starts between rows goes nowhere.
        .background(KBTheme.hitFill(dark))
        .overlay { menuOverlay }
    }

    // MARK: tabs

    private var tabs: some View {
        HStack(spacing: 0) {
            tabButton(.clipboard, Text("Clipboard"))
            tabButton(.saved, Text("Saved info"))
        }
        .padding(2)
        .background(Capsule().fill(KBTheme.control(dark)))
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .contain)
    }

    private func tabButton(_ value: Tab, _ label: Text) -> some View {
        let selected = tab == value
        return Button {
            tab = value
            menuFor = nil
            savingFor = nil
        } label: {
            label
                .font(.caption.weight(.medium))
                .foregroundStyle(selected ? KBTheme.ink(dark) : KBTheme.inkSoft(dark))
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
                .background {
                    if selected { Capsule().fill(KBTheme.key(dark)) }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: 剪貼簿

    private var clipboardList: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 6) {
                if !content.autoCapture { autoCaptureHint }
                if content.pinned.isEmpty && content.recent.isEmpty {
                    emptyNote(Text("Nothing copied yet. Text you paste from the strip shows up here."))
                }
                if !content.pinned.isEmpty {
                    sectionTitle(Text("Pinned"))
                    ForEach(content.pinned) { clipRow($0) }
                }
                if !content.recent.isEmpty {
                    sectionTitle(Text("Recent"))
                    ForEach(content.recent) { clipRow($0) }
                }
            }
            .padding(.bottom, 4)
        }
    }

    /// One line, and a link: the history only collects on its own once the
    /// user turns that on in Parley, and saying so here is the difference
    /// between "this is empty because it is broken" and "because it is off".
    private var autoCaptureHint: some View {
        Button {
            open(SettingsLink.clipboard.url)
        } label: {
            HStack(spacing: 4) {
                Text("Auto-collect is off. Turn it on in Parley")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
            }
            .font(.caption)
            .foregroundStyle(KBTheme.accent)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func clipRow(_ clip: ClipboardPanelContent.Clip) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if clip.pinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            Text(verbatim: clip.text)
                .font(.system(size: 15))
                .foregroundStyle(KBTheme.ink(dark))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !clip.pinned {
                Text(Self.age(clip.capturedAt))
                    .font(.caption2)
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KBTheme.key(dark)))
        .contentShape(Rectangle())
        // Tap before long press, which is also what keeps the list scrollable:
        // a lone long press in a scroll view holds the drag.
        .onTapGesture { bridge.pickClip(clip.id) }
        .onLongPressGesture(minimumDuration: 0.45) {
            savingFor = nil
            menuFor = clip
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Inserts this text. Touch and hold for more."))
        .accessibilityAction(named: clip.pinned ? Text("Unpin") : Text("Pin")) {
            bridge.setClipPinned(clip.id, !clip.pinned)
        }
        .accessibilityAction(named: Text("Delete")) { bridge.deleteClip(clip.id) }
    }

    // MARK: 常用

    private var savedList: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 6) {
                if content.snippets.isEmpty {
                    emptyNote(Text("No saved info yet. Add your name, phone numbers and addresses in Parley."))
                    Button {
                        open(SettingsLink.snippets.url)
                    } label: {
                        Text("Add in Parley")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(KBTheme.accent)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(content.snippets) { savedRow($0) }
            }
            .padding(.bottom, 4)
        }
    }

    private func savedRow(_ saved: ClipboardPanelContent.Saved) -> some View {
        Button {
            bridge.pickSnippet(saved.id)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: saved.kind.symbolName)
                    .font(.system(size: 15))
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: saved.label)
                        .font(.caption)
                        .foregroundStyle(KBTheme.inkSoft(dark))
                        .lineLimit(1)
                    Text(verbatim: saved.text)
                        .font(.system(size: 15))
                        .foregroundStyle(KBTheme.ink(dark))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KBTheme.key(dark)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // VoiceOver must not spell out a masked value bullet by bullet, nor
        // anything more of it: a sensitive row is its label and "hidden".
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: saved.label))
        .accessibilityValue(saved.sensitive ? Text("Hidden") : Text(verbatim: saved.text))
        .accessibilityHint(Text("Inserts this text."))
    }

    // MARK: the long-press menu

    @ViewBuilder
    private var menuOverlay: some View {
        if let clip = savingFor ?? menuFor {
            ZStack(alignment: .bottom) {
                // Tapping anywhere outside the menu dismisses it.
                Color.black.opacity(dark ? 0.35 : 0.18)
                    .onTapGesture {
                        menuFor = nil
                        savingFor = nil
                    }
                    .accessibilityHidden(true)
                VStack(spacing: 8) {
                    if savingFor != nil {
                        Text("Save as")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(KBTheme.inkSoft(dark))
                        HStack(spacing: 8) {
                            ForEach(clip.saveAs) { kind in
                                menuButton(Text(verbatim: kind.displayName), symbol: kind.symbolName) {
                                    bridge.saveClip(clip.id, as: kind)
                                    savingFor = nil
                                    menuFor = nil
                                }
                            }
                        }
                    } else {
                        HStack(spacing: 8) {
                            menuButton(
                                clip.pinned ? Text("Unpin") : Text("Pin"),
                                symbol: clip.pinned ? "pin.slash" : "pin"
                            ) {
                                bridge.setClipPinned(clip.id, !clip.pinned)
                                menuFor = nil
                            }
                            menuButton(Text("Delete"), symbol: "trash", destructive: true) {
                                bridge.deleteClip(clip.id)
                                menuFor = nil
                            }
                            if !clip.saveAs.isEmpty {
                                menuButton(Text("Save as saved info"), symbol: "tray.and.arrow.down") {
                                    savingFor = clip
                                }
                            }
                        }
                    }
                    Button {
                        menuFor = nil
                        savingFor = nil
                    } label: {
                        Text("Cancel")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(KBTheme.inkSoft(dark))
                            .padding(.vertical, 2)
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(KBTheme.control(dark))
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color(white: dark ? 0.16 : 0.96))))
                .padding(.horizontal, KBMetrics.sideInset + 6)
                .padding(.bottom, 8)
            }
        }
    }

    private func menuButton(
        _ title: Text, symbol: String, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 15))
                title.font(.caption2.weight(.medium)).lineLimit(1).minimumScaleFactor(0.7)
            }
            .foregroundStyle(destructive ? KBTheme.recording : KBTheme.ink(dark))
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KBTheme.key(dark)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: pieces

    private func sectionTitle(_ title: Text) -> some View {
        title
            .font(.caption2.weight(.semibold))
            .foregroundStyle(KBTheme.inkSoft(dark))
            .padding(.top, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private func emptyNote(_ text: Text) -> some View {
        text
            .font(.footnote)
            .foregroundStyle(KBTheme.inkSoft(dark))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 6)
    }

    /// Into Parley's Settings — the same `openURL` path the voice pane uses to
    /// reach the app, with the responder-chain fallback for older systems.
    private func open(_ url: URL) {
        openURL(url) { accepted in
            if !accepted { bridge.fallbackOpen(url) }
        }
    }

    /// "2 min ago", "3 hr ago" — the system's own short relative phrasing, in
    /// the phone's language.
    private static func age(_ date: Date) -> String {
        if Date().timeIntervalSince(date) < 60 { return ageFormatter.localizedString(fromTimeInterval: 0) }
        return ageFormatter.localizedString(for: date, relativeTo: Date())
    }

    private static let ageFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        f.dateTimeStyle = .named
        return f
    }()
}
