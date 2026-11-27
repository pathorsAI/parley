import ParleyKit
import SwiftUI

// Meeting drafts on the Library overview, read-only (#772): the desktop's
// 即將開始的會議 and 會議草稿 (`src/components/home/UpcomingMeetings.tsx`,
// `DraftRow.tsx`), and a page that shows one draft. Drafts are made and
// edited on the desktop (or by an AI over the cloud MCP); the phone shows
// them, and starts a meeting from one (開始, as the desktop's row) — never
// create, edit or delete. Starting hides the draft on this phone rather than
// deleting it (`TabRouter.startedDraftIDs`). `LibraryView` loads them, places
// the sections and routes 開始; everything here only draws.

// MARK: - Sections

/// 即將開始的會議 then 會議草稿, split and ordered as the desktop does
/// (`MeetingDraftSchedule.split`). A section with nothing in it is left out
/// rather than drawn empty: on the phone they sit above the folders, and two
/// empty boxes there would push the library down for nothing.
///
/// Re-reads the clock every 30 s, as the desktop's `useNow` does, so a
/// meeting moves up into 即將開始 and its "in 25 min" counts down while the
/// page is open.
struct OverviewDraftSections<Row: View>: View {
    /// Which of the overview's two draft sections this is: they sit apart,
    /// 即將開始的會議 above the folders and 會議草稿 under them.
    enum Part { case startingSoon, later }

    let drafts: [CloudMeetingDraft]
    let part: Part
    /// Rows shown at most; past it the heading offers 查看全部. nil = all.
    var limit: Int? = nil
    /// Opens every draft of this part (the overview's 查看全部).
    var seeAll: (() -> Void)? = nil
    /// The section's own heading; off on the 查看全部 page, whose title says it.
    var showsHeading = true
    let folderName: (String?) -> String?
    /// Wraps a row in whatever opens it (a navigation link on the overview).
    @ViewBuilder var link: (CloudMeetingDraft, DraftRow) -> Row

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date.timeIntervalSince1970 * 1000
            let split = MeetingDraftSchedule.split(drafts, now: now)
            switch part {
            case .startingSoon:
                if !split.startingSoon.isEmpty {
                    section("Starting soon", split.startingSoon, now: now)
                }
            case .later:
                if !split.later.isEmpty {
                    section("Meeting drafts", split.later, now: now)
                }
            }
        }
    }

    private func section(_ title: LocalizedStringKey, _ rows: [CloudMeetingDraft], now: Double)
        -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            if showsHeading {
                // `OverviewHeading`'s look, with the desktop's count right beside
                // the title rather than across the row.
                HStack(spacing: 6) {
                    Text(title)
                        .font(.parley.caption.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(verbatim: "\(rows.count)")
                        .font(.parley.caption.monospacedDigit())
                        .accessibilityHidden(true)
                }
                .foregroundStyle(Color(.secondaryLabel))
                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                .overlay(alignment: .trailing) {
                    // 最近錄音's 查看全部, only when there are more than are shown.
                    if let limit, rows.count > limit, let seeAll {
                        Button(action: seeAll) {
                            HStack(spacing: 3) {
                                Text("See all")
                                Image(systemName: "arrow.right").imageScale(.small)
                            }
                            .font(.parley.caption)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
            HairlineList(items: limit.map { Array(rows.prefix($0)) } ?? rows) { draft in
                link(
                    draft,
                    DraftRow(draft: draft, now: now, folder: folderName(draft.meetingFolderId)))
            }
        }
    }
}

// MARK: - Row

/// A draft's title, or the desktop's 未命名的會議 when it has none.
struct DraftTitle: View {
    let draft: CloudMeetingDraft

    var body: some View {
        if draft.title.trimmingCharacters(in: .whitespaces).isEmpty {
            Text("Untitled meeting")
        } else {
            Text(verbatim: draft.title)
        }
    }
}

/// The desktop's `DraftRow`, phone-sized: the lead column (16:00 today, 10/31
/// another day, 未定 without a time), the title, and under it how soon and
/// which folder. The row's 開始 is `DraftStartButton`, set beside it by
/// whoever places the row, so the button is not inside the row's link.
struct DraftRow: View {
    let draft: CloudMeetingDraft
    let now: Double
    let folder: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Group {
                if let lead = DraftTime.lead(draft, now: now) {
                    Text(verbatim: lead)
                } else {
                    Text("No time")
                }
            }
            .font(.parley.caption.monospacedDigit())
            .foregroundStyle(Color(.secondaryLabel))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            // Wide enough for "No time" at the caption size on an SE.
            .frame(width: 48, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                DraftTitle(draft: draft)
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                if soon != nil || folder != nil {
                    HStack(spacing: 10) {
                        if let soon {
                            DraftSoonLabel(soon: soon)
                                .fixedSize()
                        }
                        if let folder {
                            Label {
                                Text(verbatim: folder).lineLimit(1)
                            } icon: {
                                Image(systemName: "folder")
                            }
                            .labelStyle(OverviewLinkLabelStyle())
                            .foregroundStyle(Color(.secondaryLabel))
                        }
                    }
                    .font(.parley.caption)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var soon: DraftSoon? { DraftSoon(draft, now: now) }
}

/// The desktop's 開始 (`DraftRow.tsx`): a small outline button at the row's
/// trailing edge — page-coloured fill, hairline border, label-coloured
/// medium text, 28 pt tall — under a 44 pt tap target.
struct DraftStartButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Start")
                .font(.parley.caption.weight(.medium))
                .foregroundStyle(Color(.label))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Theme.background))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color(.separator), lineWidth: 1))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// What a draft's row says about its time, as the desktop's row does. A draft
/// is still a draft once its time comes — nothing was recorded — so it never
/// says the meeting "started": inside its slot the start time has gone by,
/// after the slot it has lapsed.
enum DraftSoon: Equatable {
    case until(MeetingDraftSchedule.Until)
    case pastStart
    case missed

    init?(_ d: CloudMeetingDraft, now: Double) {
        guard let start = d.meetingAt else { return nil }
        let until = MeetingDraftSchedule.untilStart(start, now: now)
        if until != .started {
            self = .until(until)
        } else if MeetingDraftSchedule.isOver(d, now: now) {
            self = .missed
        } else {
            self = .pastStart
        }
    }
}

struct DraftSoonLabel: View {
    let soon: DraftSoon

    var body: some View {
        switch soon {
        case .until(.minutes(let n)): Text("in \(n) min").foregroundStyle(Color(.secondaryLabel))
        case .until(.hours(let n)): Text("in \(n) hr").foregroundStyle(Color(.secondaryLabel))
        case .until(.days(let n)): Text("in \(n) days").foregroundStyle(Color(.secondaryLabel))
        case .until(.started): EmptyView()
        // The one to act on: the desktop's primary, medium weight.
        case .pastStart:
            Text("Past start time")
                .font(.parley.caption.weight(.medium))
                .foregroundStyle(Theme.primary)
        case .missed: Text("Missed").foregroundStyle(Color(.secondaryLabel))
        }
    }
}

/// How a draft's time reads.
enum DraftTime {
    /// The row's lead column: the clock time for a meeting today, the date for
    /// any other day (24-hour and numeric, as the desktop's row). nil = no time.
    static func lead(_ d: CloudMeetingDraft, now: Double) -> String? {
        guard let at = d.meetingAt else { return nil }
        let date = Date(timeIntervalSince1970: at / 1000)
        let today = Date(timeIntervalSince1970: now / 1000)
        if Calendar.current.isDate(date, inSameDayAs: today) {
            return date.formatted(
                .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                    .locale(Self.twentyFourHour))
        }
        return date.formatted(.dateTime.month(.defaultDigits).day())
    }

    /// The detail page's line: the day, the start and the end.
    static func full(_ d: CloudMeetingDraft) -> String? {
        guard let at = d.meetingAt else { return nil }
        let start = Date(timeIntervalSince1970: at / 1000)
        // The year only outside the current one, as the recording rows do.
        let dayStyle = Date.FormatStyle.dateTime.month(.abbreviated).day().weekday(.abbreviated)
        let day = start.formatted(
            Calendar.current.isDate(start, equalTo: .now, toGranularity: .year)
                ? dayStyle : dayStyle.year())
        let clock = Date.FormatStyle.dateTime.hour().minute()
        guard let endAt = d.meetingEndAt, endAt > at else {
            return "\(day) \(start.formatted(clock))"
        }
        let end = Date(timeIntervalSince1970: endAt / 1000)
        if Calendar.current.isDate(start, inSameDayAs: end) {
            return "\(day) \(start.formatted(clock)) – \(end.formatted(clock))"
        }
        return "\(day) \(start.formatted(clock)) – \(end.formatted(.dateTime.month(.abbreviated).day().hour().minute()))"
    }

    /// The phone's language with a 24-hour clock: the desktop's row is
    /// `hour12: false` in both languages.
    private static var twentyFourHour: Locale {
        var comps = Locale.Components(locale: .current)
        comps.hourCycle = .zeroToTwentyThree
        return Locale(components: comps)
    }
}

// MARK: - Detail

/// One draft, read-only: its title, when, which folder the recording will be
/// filed into, the context the desktop prepared, and the agenda, with 開始錄音
/// under the heading — the row's 開始 at the page's size. Editing is the
/// desktop's; the page says so at the bottom rather than offering a button
/// that cannot work.
struct MeetingDraftDetailView: View {
    let draft: CloudMeetingDraft
    let folder: String?
    /// Start a meeting from this draft (`TabRouter.startDraft`). nil = no
    /// start button: the record screen's sheet, for the meeting already
    /// started from it.
    var onStart: (() -> Void)?
    /// The meeting's agenda, when the page is the record screen's sheet for a
    /// meeting started from this draft: tickable, and the ticks are the
    /// meeting's (saved with the recording), never the draft's. nil = the
    /// Library's read-only page, showing the draft's todos as they are.
    var agenda: Binding<[AgendaItem]>?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            let now = timeline.date.timeIntervalSince1970 * 1000
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header(now: now)
                    if let onStart { startButton(onStart) }
                    if !preparedContext.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            OverviewHeading(title: "Draft context")
                            Text(verbatim: preparedContext)
                                .font(.parley.body)
                                .foregroundStyle(Color(.label))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if let agenda {
                        if !agenda.wrappedValue.isEmpty { tickableAgenda(agenda) }
                    } else if !draftAgenda.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            OverviewHeading(title: "Agenda")
                            HairlineList(items: draftAgenda) { item in
                                agendaRow(text: item.text, done: item.done)
                                    .accessibilityElement(children: .combine)
                                    .accessibilityAddTraits(item.done ? .isSelected : [])
                            }
                        }
                    }
                    Text("Drafts are edited in Parley on the desktop.")
                        .font(.parley.caption)
                        .foregroundStyle(Color(.tertiaryLabel))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                // The page's width, not the content's: a draft with only a time
                // and a folder would otherwise sit centred, off the left edge.
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
        }
        .background(Theme.background)
        .navigationTitle("Meeting draft")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The record screen's light-primary start control: blue ink and the
    /// record dot on a faint blue wash, full width.
    private func startButton(_ onStart: @escaping () -> Void) -> some View {
        Button(action: onStart) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Theme.primary)
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                Text("Start recording")
                    .font(.parley.subheadlineEmphasized)
            }
            .foregroundStyle(Theme.primary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Theme.primary.opacity(0.12)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The context the desktop prepared (its 補充背景), as written.
    private var preparedContext: String {
        draft.meetingContext.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The meeting's to-do list: a tap ticks or unticks, the desktop's
    /// `toggleAgendaItem`.
    private func tickableAgenda(_ agenda: Binding<[AgendaItem]>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            OverviewHeading(title: "Agenda")
            HairlineList(items: agenda.wrappedValue) { item in
                Button {
                    if let i = agenda.wrappedValue.firstIndex(where: { $0.id == item.id }) {
                        agenda.wrappedValue[i] = agenda.wrappedValue[i].toggled()
                    }
                } label: {
                    agendaRow(text: item.text, done: item.done)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(item.done ? .isSelected : [])
            }
        }
    }

    /// One agenda line: a check circle, then the item — struck through and
    /// greyed once done.
    private func agendaRow(text: String, done: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? Theme.primary : Color(.tertiaryLabel))
                .accessibilityHidden(true)
            Text(verbatim: text)
                .font(.parley.subheadline)
                .foregroundStyle(done ? Color(.secondaryLabel) : Color(.label))
                .strikethrough(done, color: Color(.secondaryLabel))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 10)
    }

    private var draftAgenda: [CloudDraftTodo] {
        draft.todos.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func header(now: Double) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            DraftTitle(draft: draft)
            .font(.parley.title2)
            .foregroundStyle(Color(.label))
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        if let full = DraftTime.full(draft) {
                            Text(verbatim: full)
                        } else {
                            Text("No time set yet")
                        }
                        if let soon = DraftSoon(draft, now: now) {
                            DraftSoonLabel(soon: soon)
                        }
                    }
                } icon: {
                    Image(systemName: "calendar")
                }
                if let folder {
                    Label {
                        Text(verbatim: folder)
                    } icon: {
                        Image(systemName: "folder")
                    }
                }
            }
            .font(.parley.subheadline)
            .foregroundStyle(Color(.secondaryLabel))
        }
    }
}

#if DEBUG
    #Preview("Draft sections") {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    ForEach([OverviewDraftSections<DraftRow>.Part.startingSoon, .later], id: \.self) { part in
                        OverviewDraftSections(
                            drafts: ScreenshotDemo.drafts, part: part,
                            folderName: { id in ScreenshotDemo.folders.first { $0.id == id }?.name }
                        ) { _, row in row }
                    }
                }
                .padding(20)
            }
        }
    }

    #Preview("Draft detail") {
        NavigationStack {
            MeetingDraftDetailView(draft: ScreenshotDemo.drafts[0], folder: "Renewals", onStart: {})
        }
    }
#endif
