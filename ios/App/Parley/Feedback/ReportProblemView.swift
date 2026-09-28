import ParleyKit
import SwiftUI

/// 「回報問題」 — the one place a report has words the user wrote.
///
/// Everything on it is optional except the decision to send: the text box can
/// be left empty (the diagnostics are the report), and a screenshot, when there
/// is one, is shown in full so the user can see exactly what would go and take
/// it out. The line under the box says what is attached and what never is,
/// before the button rather than in a policy somewhere else.
///
/// Presented through UIKit (`FeedbackCenter.presentReport`) rather than as a
/// SwiftUI `.sheet`, so it can open over whatever is already on screen —
/// including another sheet, which is where a screenshot is often taken.
struct ReportProblemView: View {
    let screenshot: UIImage?
    let send: (_ message: String, _ screenshot: UIImage?) -> Void
    let cancel: () -> Void

    @State private var message = ""
    @State private var keepsScreenshot = true
    @FocusState private var focused: Bool

    private static let faqURL = URL(string: "https://parley.tw/support/")!

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    editor
                    if let screenshot, keepsScreenshot {
                        screenshotPreview(screenshot)
                    }
                    Text("The app version, device, and recent error log are attached. Never your recordings or transcripts.")
                        .font(.parley.footnote)
                        .foregroundStyle(Color(.secondaryLabel))
                        .fixedSize(horizontal: false, vertical: true)
                    Link(destination: Self.faqURL) {
                        Label("FAQ", systemImage: "questionmark.circle")
                            .font(.parley.subheadline)
                    }
                    .padding(.top, 8)
                }
                .padding(20)
            }
            .background(Theme.background)
            .navigationTitle("Report a problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        send(message, keepsScreenshot ? screenshot : nil)
                    }
                    .font(.parley.bodyEmphasized)
                }
            }
        }
        .font(.parley.body)
    }

    /// A multi-line box with the placeholder drawn under it: `TextEditor` has
    /// no placeholder of its own, and `TextField(axis: .vertical)` grows from
    /// one line, which reads as "one line is expected" on a screen whose whole
    /// point is room to explain.
    private var editor: some View {
        ZStack(alignment: .topLeading) {
            if message.isEmpty {
                Text("What happened? (optional)")
                    .foregroundStyle(Color(.placeholderText))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $message)
                .focused($focused)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 140)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(.separator), lineWidth: 0.5))
        .onChange(of: message) { _, typed in
            if typed.count > FeedbackPayload.maxMessageLength {
                message = String(typed.prefix(FeedbackPayload.maxMessageLength))
            }
        }
    }

    private func screenshotPreview(_ image: UIImage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 280)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 0.5))
                .accessibilityLabel(Text("Screenshot"))
            Button(role: .destructive) {
                withAnimation { keepsScreenshot = false }
            } label: {
                Label("Remove screenshot", systemImage: "xmark.circle")
                    .font(.parley.subheadline)
            }
        }
    }
}

/// A short line at the bottom of the screen, with an optional action. Drawn in
/// its own window by `FeedbackOverlay`, sized to itself, so it never covers
/// anything it is not.
struct FeedbackToast: View {
    let text: String
    var action: String?
    var perform: (() -> Void)?

    var body: some View {
        HStack(spacing: 14) {
            Text(verbatim: text)
                .font(.parley.subheadline)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
            if let action, let perform {
                Button(action: perform) {
                    Text(verbatim: action)
                        .font(.parley.subheadlineEmphasized)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.thickMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color(.separator), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
        // Not combined: the action has to stay a button VoiceOver can reach on
        // its own, not a trait folded into a sentence.
    }
}

/// 「Parley 上次意外關閉了」 — shown at the next launch after a crash, only when
/// the user has turned automatic crash reports off. Answered once per crash:
/// either button clears it, and ticking "Always send automatically" means it is
/// never asked again.
struct CrashBanner: View {
    let send: (_ alwaysSend: Bool) -> Void
    let decline: (_ alwaysSend: Bool) -> Void
    @State private var alwaysSend = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Parley closed unexpectedly last time")
                    .font(.parley.subheadlineEmphasized)
                Text("Send a crash report? It contains nothing from your recordings.")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Toggle(isOn: $alwaysSend) {
                Text("Always send automatically").font(.parley.footnote)
            }
            .toggleStyle(CheckboxToggleStyle())
            HStack(spacing: 20) {
                Spacer(minLength: 0)
                Button("Don't send") { decline(alwaysSend) }
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
                Button("Send report") { send(alwaysSend) }
                    .font(.parley.subheadlineEmphasized)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(.separator), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }
}

/// A tick box, which is what 「以後自動傳送」 is in the approved design — a
/// switch inside a banner reads as a setting that already took effect.
private struct CheckboxToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
                    .foregroundStyle(configuration.isOn ? Theme.primary : Color(.secondaryLabel))
                configuration.label.foregroundStyle(Color(.label))
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(configuration.isOn ? [.isSelected] : [])
    }
}
