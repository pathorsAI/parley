// `os(iOS)` rather than `canImport(ActivityKit)`, which would be the obvious
// spelling and is wrong: the macOS SDK ships ActivityKit.framework, so the
// import succeeds there, and every type inside it is then
// `@available(macOS, unavailable)`. The guard has to be about the platform,
// because that is what the framework's availability is about.
#if os(iOS)
    import ActivityKit

    /// The ActivityKit half of the microphone card: the type the app starts an
    /// `Activity` with and the widget declares its `ActivityConfiguration`
    /// against.
    ///
    /// **It carries nothing**, and that is the design rather than an omission.
    /// A Live Activity's attributes are fixed at `request(...)` and can never
    /// be updated again; only `ContentState` can. The meeting's title is the
    /// obvious thing to put here and the worst one — a recording renamed while
    /// it runs, or one started before its name is known, would show the old
    /// name on the lock screen until it ended. Anything that could conceivably
    /// change belongs in `MicActivityState`, and it turns out everything can.
    ///
    /// It is a separate file from `MicActivityState.swift` only because of the
    /// `#if` around it. ActivityKit is iOS-only, and ParleyKit builds for macOS
    /// too so its logic can be unit-tested without a simulator (see
    /// `Package.swift`). Everything the card decides —
    /// `MicActivityState.derive`, `MicActivityPolicy` — therefore lives on the
    /// other side of that line, in a file that imports nothing but Foundation.
    /// Putting the two in one file would compile, but the guard would have to
    /// wrap the logic too, and the tests would quietly stop covering it.
    public struct MicActivityAttributes: ActivityAttributes {
        public typealias ContentState = MicActivityState

        public init() {}
    }
#endif
