import ParleyKit
import SwiftUI

/// Steps 3 and 4 of the onboarding — the organization and the hand-off — shown
/// over the tabs right after a first sign-in. See `OnboardingStep`.
///
/// Mirrors the desktop wizard's `org` and `done` steps: join an organization
/// you were invited to, create one, or carry on as an individual; then start
/// from the sample recording or a real one.
struct OnboardingAfterSignIn: View {
    enum Exit { case sample, record }

    @EnvironmentObject private var app: AppState
    @StateObject private var org = OnboardingOrgModel()
    @State private var step: OnboardingStep
    @State private var orgName = ""
    private let finish: (Exit) -> Void

    init(startAt: OnboardingStep = .org, finish: @escaping (Exit) -> Void) {
        _step = State(initialValue: startAt == .done ? .done : .org)
        self.finish = finish
    }

    var body: some View {
        Group {
            if step == .done {
                doneStep.transition(.opacity)
            } else {
                orgStep.transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: step)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .task { await org.load(app: app) }
    }

    // MARK: 3 · organization

    private var orgStep: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Organization")
                        .font(.parley.title2)
                        .foregroundStyle(Color(.label))
                        .padding(.top, 32)
                        .padding(.bottom, 4)
                    orgContent
                    if let error = org.actionError {
                        Text(error)
                            .font(.parley.footnote)
                            .foregroundStyle(Theme.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: 420, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: 12) {
                OnboardingDots(current: .org)
                orgFooter
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 28)
            .padding(.top, 8)
            .padding(.bottom, 20)
        }
    }

    @ViewBuilder
    private var orgContent: some View {
        switch org.phase {
        case .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Checking your organizations…")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        case .failed:
            VStack(alignment: .leading, spacing: 12) {
                Text("Couldn't load your organizations. Retry, or skip for now.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.label))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Retry") { Task { await org.load(app: app) } }
                    .font(.parley.subheadlineEmphasized)
            }
        case .joined:
            joinedCard
        case .choosing:
            ForEach(org.invitations) { invitation in
                invitationCard(invitation)
            }
            createCard
            soloCard
        }
    }

    /// Choosing has no footer: each card carries its own button, the way the
    /// desktop's organization step does while it offers its choices.
    @ViewBuilder
    private var orgFooter: some View {
        switch org.phase {
        case .joined:
            OnboardingPrimaryButton(title: "Next") { step = .done }
        case .failed:
            Button("Skip") { step = .done }
                .font(.parley.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        case .loading, .choosing:
            EmptyView()
        }
    }

    private var joinedCard: some View {
        OnboardingCard {
            Label("You're in an organization", systemImage: "checkmark.circle.fill")
                .font(.parley.headline)
                .foregroundStyle(Color(.label))
            ForEach(org.joinedNames, id: \.self) { name in
                Text(verbatim: name)
                    .font(.parley.bodyEmphasized)
                    .foregroundStyle(Color(.label))
            }
            Text("Everyone in the organization can see the recordings shared to it.")
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func invitationCard(_ invitation: CloudInvitation) -> some View {
        OnboardingCard {
            Text("“\(invitation.organizationName ?? invitation.organizationId)” invited you to join")
                .font(.parley.headline)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
            OnboardingSmallButton(title: "Join", filled: true, busy: org.busy) {
                Task { await org.accept(invitation, app: app) }
            }
        }
    }

    private var createCard: some View {
        OnboardingCard {
            Text("Create an organization")
                .font(.parley.headline)
                .foregroundStyle(Color(.label))
            Text("Invite members by email later in the desktop app, under Settings › Organizations.")
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
            TextField("Organization name", text: $orgName)
                .font(.parley.body)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.done)
                .onSubmit { create() }
            OnboardingSmallButton(title: "Create", filled: true, busy: org.busy) { create() }
        }
    }

    private var soloCard: some View {
        OnboardingCard {
            Text("Use the personal edition")
                .font(.parley.headline)
                .foregroundStyle(Color(.label))
            Text("Create or join one later in the desktop app, under Settings › Organizations.")
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
            OnboardingSmallButton(title: "Continue", filled: false, busy: false) { step = .done }
                .disabled(org.busy)
        }
    }

    private func create() {
        Task { await org.create(name: orgName, app: app) }
    }

    // MARK: 4 · done

    private var doneStep: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 14) {
                    Spacer(minLength: 64)
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 52, weight: .regular))
                        .foregroundStyle(Theme.success)
                        .accessibilityHidden(true)
                    Text("You're all set!")
                        .font(.parley.title2)
                        .foregroundStyle(Color(.label))
                    Text("Get to know Parley in five minutes:")
                        .font(.parley.headline)
                        .foregroundStyle(Color(.label))
                        .multilineTextAlignment(.center)
                    Text("Start from a sample recording for a quick tour of filing, replay and AI analysis.")
                        .font(.parley.subheadline)
                        .foregroundStyle(Color(.secondaryLabel))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: 420)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
            }
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 12) {
                OnboardingDots(current: .done)
                OnboardingPrimaryButton(title: "Try the sample") { finish(.sample) }
                Button("Start recording") { finish(.record) }
                    .font(.parley.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 28)
            .padding(.top, 8)
            .padding(.bottom, 20)
        }
    }
}

// MARK: - model

/// What the organization step knows: the user's organizations and the
/// invitations still open to them, and whether a join or create is in flight.
@MainActor
final class OnboardingOrgModel: ObservableObject {
    enum Phase: Equatable { case loading, failed, choosing, joined }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var invitations: [CloudInvitation] = []
    @Published private(set) var joinedNames: [String] = []
    @Published private(set) var busy = false
    @Published private(set) var actionError: String?

    func load(app: AppState) async {
        phase = .loading
        actionError = nil
        #if DEBUG
            if ScreenshotDemo.isActive {
                loadDemo()
                return
            }
        #endif
        let cloud = app.cloud
        do {
            let orgs = try await cloud.myOrgs()
            let open = try await cloud.myInvitations()
            app.orgs = orgs
            show(orgs: orgs, invitations: open)
        } catch {
            phase = .failed
        }
    }

    func accept(_ invitation: CloudInvitation, app: AppState) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        #if DEBUG
            if ScreenshotDemo.isActive {
                try? await Task.sleep(for: .milliseconds(600))
                joined([invitation.organizationName ?? invitation.organizationId])
                return
            }
        #endif
        let cloud = app.cloud
        do {
            try await cloud.acceptInvitation(id: invitation.id)
            let orgs = (try? await cloud.myOrgs()) ?? []
            app.orgs = orgs
            joined(orgs.isEmpty ? [invitation.organizationName ?? invitation.organizationId] : orgs.map(\.name))
        } catch {
            actionError = String(localized: "That didn't work. Check your connection and try again.")
        }
    }

    func create(name: String, app: AppState) async {
        guard !busy else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            actionError = String(localized: "Enter a name, or choose the personal edition.")
            return
        }
        busy = true
        actionError = nil
        defer { busy = false }
        #if DEBUG
            if ScreenshotDemo.isActive {
                try? await Task.sleep(for: .milliseconds(600))
                joined([trimmed])
                return
            }
        #endif
        let cloud = app.cloud
        do {
            let created = try await cloud.createOrg(name: trimmed)
            let orgs = (try? await cloud.myOrgs()) ?? [created]
            app.orgs = orgs
            joined([created.name])
        } catch {
            actionError = String(localized: "That didn't work. Check your connection and try again.")
        }
    }

    private func show(orgs: [CloudOrg], invitations open: [CloudInvitation]) {
        if orgs.isEmpty {
            invitations = open
            phase = .choosing
        } else {
            joined(orgs.map(\.name))
        }
    }

    private func joined(_ names: [String]) {
        joinedNames = names
        invitations = []
        phase = .joined
    }

    #if DEBUG
        /// The demo never touches the network: each scenario is a fixture.
        private func loadDemo() {
            switch ScreenshotDemo.shared.onboarding {
            case .orgJoined:
                joined(ScreenshotDemo.orgs.map(\.name))
            case .orgInvited:
                show(orgs: [], invitations: [ScreenshotDemo.onboardingInvitation])
            default:
                show(orgs: [], invitations: [])
            }
        }
    #endif
}

// MARK: - pieces

private struct OnboardingCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Theme.radius))
    }
}

private struct OnboardingSmallButton: View {
    let title: LocalizedStringKey
    let filled: Bool
    let busy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().tint(filled ? .white : Theme.primary) }
                Text(title).font(.parley.subheadlineEmphasized)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .foregroundStyle(filled ? Color.white : Theme.primary)
            .background(
                filled ? Theme.primary : Theme.primary.opacity(0.12),
                in: RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}
