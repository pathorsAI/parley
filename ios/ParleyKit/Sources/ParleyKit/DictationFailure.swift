import Foundation

/// Why a dictation failed, reduced to the one question the app has to answer
/// the moment it does: **does the microphone stay?**
///
/// It used to be answered once for everything — an error always stopped the
/// capture, closed any microphone window and fell back to the ~30-second
/// background linger. The reasoning was that after being told something went
/// wrong, an orange indicator the user no longer has a reason to expect is the
/// worst of both. That holds when the microphone is part of the problem, or
/// when the next tap cannot work anyway. It does not hold for the commonest
/// failure there is, a dropped connection: the microphone is fine, the user
/// chose the window, and closing it guaranteed that the obvious next move — tap
/// the mic again — threw them into Parley, because a backgrounded process may
/// not open a microphone. So network failures now end the way a ⏹ does, and the
/// microphone goes back to the window or the 30-second hold.
///
/// Pure, so the table below is tested rather than scattered across the
/// coordinator's call sites.
public enum DictationFailure: String, Sendable, CaseIterable {
    /// The relay handshake failed, the reconnect ladder ran out, or a socket
    /// error ended the session. Nothing is wrong with the microphone, and a
    /// connection that comes back is exactly what the next tap needs.
    case connection
    /// No account token, or it expired mid-dictation. The next tap would fail
    /// the same way until the user signs in, which happens in Parley.
    case notSignedIn
    /// The relay refused the account for quota (402). Every redial and every
    /// tap is refused the same way until it resets.
    case quotaExhausted
    /// The microphone itself: permission denied or never granted, the audio
    /// session refusing to start, or the capture broken or lost. Holding on to
    /// it would be holding on to the problem.
    case microphone

    /// Whether the capture survives the failure: handed to the open window, or
    /// held for `holdAfterDictation`, exactly as after a ⏹. `false` stops it,
    /// closes any window and leaves only the background linger.
    public var keepsMicrophone: Bool {
        switch self {
        case .connection:
            return true
        case .notSignedIn, .quotaExhausted, .microphone:
            return false
        }
    }
}
