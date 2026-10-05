import ParleyKit
import SwiftUI

/// The saved-info panel: the 常用資訊 the user keeps in Parley, over the key
/// area the way `CandidateGrid` is — the same 213pt the panes have, so opening
/// it never changes the keyboard's height, and the track is hidden underneath
/// rather than covered (the keyboard has no background of its own to cover it
/// with).
///
/// One list: the kind's icon, the label and the value. 身分證字號 and 統一編號
/// are drawn masked; a tap inserts the whole value and closes the panel.
/// Editing is in Parley (Settings › 常用資訊), which the empty state and the
/// last row link to.
///
/// Value-fed and `Equatable` like the panes: it does not observe the bridge,
/// which publishes on every keystroke and microphone reading. The list is a
/// `LazyVStack`, so only the rows on screen are built.
struct SavedInfoPanel: View, Equatable {
    /// Actions only — see `ZhuyinPane` for why it is not observed.
    let bridge: KeyboardBridge
    var content: SavedInfoPanelContent
    var dark: Bool

    @Environment(\.openURL) private var openURL

    static func == (a: Self, b: Self) -> Bool {
        a.content == b.content && a.dark == b.dark
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 6) {
                if content.snippets.isEmpty {
                    Text("No saved info yet. Add your name, phone numbers and addresses in Parley.")
                        .font(.footnote)
                        .foregroundStyle(KBTheme.inkSoft(dark))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 6)
                    editLink(Text("Add in Parley"))
                } else {
                    ForEach(content.snippets) { row($0) }
                    editLink(Text("Edit in Parley"))
                }
            }
            .padding(.vertical, 6)
        }
        .padding(.horizontal, KBMetrics.sideInset + 6)
        .padding(.bottom, KBMetrics.paneBottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // A fully transparent point in a keyboard never receives the touch —
        // see `KeyboardRootView` — so the panel's empty space carries the same
        // sub-visible fill, or a scroll that starts between rows goes nowhere.
        .background(KBTheme.hitFill(dark))
    }

    private func row(_ saved: SavedInfoPanelContent.Saved) -> some View {
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

    /// Into Parley's Settings › 常用資訊 — the same `openURL` path the voice
    /// pane uses to reach the app, with the responder-chain fallback for older
    /// systems.
    private func editLink(_ title: Text) -> some View {
        Button {
            let url = SettingsLink.snippets.url
            openURL(url) { accepted in
                if !accepted { bridge.fallbackOpen(url) }
            }
        } label: {
            HStack(spacing: 4) {
                title
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(KBTheme.accent)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
