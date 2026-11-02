//! Notices when another app starts a call, so the frontend can ask whether to
//! record it with Parley (issue #606: people forget to press Start).
//!
//! "A call" is approximated as "another app has held the microphone for a few
//! seconds". That is cheap to observe, needs no extra permission, and covers
//! every meeting client — native apps and browser tabs alike — without
//! knowing anything about them. Nothing is captured: the watcher only reads
//! whether, and which, apps are using an input device.
//!
//! - macOS 14.2+: the CoreAudio process objects
//!   (`kAudioHardwarePropertyProcessObjectList`) say per process whether it is
//!   running input, plus its PID and bundle id. Older macOS falls back to
//!   `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input
//!   device: someone is using the mic, but not who.
//! - Windows: the microphone consent store in the registry. An app is using
//!   the mic right now when its `LastUsedTimeStop` is 0 (and it has started).
//! - Elsewhere: nothing is detected.
//!
//! A background thread polls every [`POLL`]. [`Tracker`] (pure, unit-tested)
//! turns the polls into at most one `meeting://detected` per continuous mic
//! session of an app, and a `meeting://ended` when an app it announced lets go.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::capture::{MicCoordinator, MicUser};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// `MicApp`: another app has held the mic long enough to be a call.
pub const DETECTED_EVENT: &str = "meeting://detected";
/// `MicApp`: an app that was announced released the mic.
pub const ENDED_EVENT: &str = "meeting://ended";

/// How often the mic users are polled.
const POLL: Duration = Duration::from_secs(3);
/// How long an app must hold the mic before it counts as a call.
pub const HOLD: Duration = Duration::from_secs(5);
/// How long an app must leave the mic alone before a new hold is a new call:
/// long enough to ride out a device switch (the mic drops for a poll or two),
/// short enough that leaving a call and joining again asks again.
pub const REARM: Duration = Duration::from_secs(6);

/// What kind of app holds the mic; the prompt words the two first apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    /// A browser — most likely Google Meet or another web call.
    Browser,
    /// A native app (known or not).
    App,
    /// The mic is in use, but the OS did not say by whom (macOS < 14.2).
    Unknown,
}

/// An app using the microphone, as the frontend sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicApp {
    /// Stable, lowercase id: a bundle id (macOS), an exe name or a package
    /// family name (Windows). What the muted list stores. Empty for `Unknown`.
    pub app_id: String,
    /// A name to show the user ("Zoom", "Google Chrome"). Empty for `Unknown`.
    pub app_name: String,
    pub kind: AppKind,
}

/// One mic user as a platform reports it, before naming.
#[derive(Clone, Debug, PartialEq, Eq)]
// Only macOS reports an unidentified user; only macOS and Windows report any.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Holder {
    /// Something is using the mic; the OS cannot tell what.
    Unidentified,
    /// A process (or Windows app) using the mic.
    Process {
        /// Bundle id / exe name / package family name, any case.
        id: String,
        /// The app it belongs to, if it belongs to one: the outermost `.app`
        /// bundle's name on macOS (None for a bare daemon or CLI tool), the
        /// exe stem or package name on Windows.
        app_name: Option<String>,
    },
}

#[derive(Clone, Copy)]
enum Match {
    Prefix,
    Exact,
}

/// Known apps: (pattern on the lowercase id, how it matches, canonical id,
/// name, kind). Bundle ids (macOS), exe names and package family names
/// (Windows) share one table; they never collide.
const KNOWN: &[(&str, Match, &str, &str, AppKind)] = {
    use AppKind::{App, Browser};
    use Match::{Exact, Prefix};
    &[
        // Meeting and chat apps.
        ("us.zoom.", Prefix, "us.zoom.xos", "Zoom", App),
        ("zoom.exe", Exact, "zoom.exe", "Zoom", App),
        (
            "com.microsoft.teams",
            Prefix,
            "com.microsoft.teams2",
            "Microsoft Teams",
            App,
        ),
        (
            "ms-teams.exe",
            Exact,
            "ms-teams.exe",
            "Microsoft Teams",
            App,
        ),
        ("teams.exe", Exact, "teams.exe", "Microsoft Teams", App),
        ("msteams_", Prefix, "msteams", "Microsoft Teams", App),
        ("com.hnc.discord", Prefix, "com.hnc.discord", "Discord", App),
        ("discord.exe", Exact, "discord.exe", "Discord", App),
        (
            "com.tinyspeck.slackmacgap",
            Prefix,
            "com.tinyspeck.slackmacgap",
            "Slack",
            App,
        ),
        ("slack.exe", Exact, "slack.exe", "Slack", App),
        (
            "cisco-systems.spark",
            Prefix,
            "cisco-systems.spark",
            "Webex",
            App,
        ),
        (
            "com.cisco.webex",
            Prefix,
            "com.cisco.webexmeetingsapp",
            "Webex",
            App,
        ),
        (
            "com.webex.",
            Prefix,
            "com.webex.meetingmanager",
            "Webex",
            App,
        ),
        ("webex.exe", Exact, "webex.exe", "Webex", App),
        (
            "ciscocollabhost.exe",
            Exact,
            "ciscocollabhost.exe",
            "Webex",
            App,
        ),
        ("atmgr.exe", Exact, "atmgr.exe", "Webex", App),
        (
            "com.apple.facetime",
            Prefix,
            "com.apple.facetime",
            "FaceTime",
            App,
        ),
        // FaceTime's audio runs in this daemon rather than the app.
        (
            "com.apple.avconferenced",
            Exact,
            "com.apple.facetime",
            "FaceTime",
            App,
        ),
        ("com.skype.", Prefix, "com.skype.skype", "Skype", App),
        ("skype.exe", Exact, "skype.exe", "Skype", App),
        (
            "microsoft.skypeapp_",
            Prefix,
            "microsoft.skypeapp",
            "Skype",
            App,
        ),
        ("jp.naver.line", Prefix, "jp.naver.line.mac", "LINE", App),
        ("line.exe", Exact, "line.exe", "LINE", App),
        (
            "ru.keepcoder.telegram",
            Prefix,
            "ru.keepcoder.telegram",
            "Telegram",
            App,
        ),
        (
            "org.telegram.",
            Prefix,
            "org.telegram.desktop",
            "Telegram",
            App,
        ),
        ("telegram.exe", Exact, "telegram.exe", "Telegram", App),
        (
            "telegrammessengerllp.telegramdesktop_",
            Prefix,
            "telegramdesktop",
            "Telegram",
            App,
        ),
        (
            "net.whatsapp.",
            Prefix,
            "net.whatsapp.whatsapp",
            "WhatsApp",
            App,
        ),
        (
            "desktop.whatsapp",
            Prefix,
            "desktop.whatsapp",
            "WhatsApp",
            App,
        ),
        ("whatsapp.exe", Exact, "whatsapp.exe", "WhatsApp", App),
        (
            "5319275a.whatsappdesktop_",
            Prefix,
            "whatsappdesktop",
            "WhatsApp",
            App,
        ),
        // Browsers: a web call (Google Meet, Teams on the web, …). Helper
        // processes share the browser's id prefix.
        (
            "com.google.chrome",
            Prefix,
            "com.google.chrome",
            "Google Chrome",
            Browser,
        ),
        ("chrome.exe", Exact, "chrome.exe", "Google Chrome", Browser),
        (
            "com.apple.safari",
            Prefix,
            "com.apple.safari",
            "Safari",
            Browser,
        ),
        // Safari captures in WebKit's GPU process.
        (
            "com.apple.webkit.gpu",
            Exact,
            "com.apple.safari",
            "Safari",
            Browser,
        ),
        (
            "com.microsoft.edgemac",
            Prefix,
            "com.microsoft.edgemac",
            "Microsoft Edge",
            Browser,
        ),
        ("msedge.exe", Exact, "msedge.exe", "Microsoft Edge", Browser),
        (
            "company.thebrowser.",
            Prefix,
            "company.thebrowser.browser",
            "Arc",
            Browser,
        ),
        ("arc.exe", Exact, "arc.exe", "Arc", Browser),
        (
            "thebrowsercompany.arc_",
            Prefix,
            "thebrowsercompany.arc",
            "Arc",
            Browser,
        ),
        (
            "org.mozilla.firefox",
            Prefix,
            "org.mozilla.firefox",
            "Firefox",
            Browser,
        ),
        ("firefox.exe", Exact, "firefox.exe", "Firefox", Browser),
        (
            "com.brave.browser",
            Prefix,
            "com.brave.browser",
            "Brave",
            Browser,
        ),
        ("brave.exe", Exact, "brave.exe", "Brave", Browser),
    ]
};

/// Mic users that are never a meeting: Parley itself, and dictation / voice
/// assistant tools that hold the mic while someone talks to their computer.
const IGNORED: &[(&str, Match)] = {
    use Match::{Exact, Prefix};
    &[
        ("com.pathors.parley", Prefix),
        ("parley.exe", Exact),
        ("com.electron.wispr-flow", Prefix),
        ("com.wispr", Prefix),
        ("wispr flow.exe", Exact),
        ("wisprflow.exe", Exact),
        ("com.superduper.superwhisper", Prefix),
        ("now.typeless.", Prefix),
        ("typeless.exe", Exact),
        ("com.apple.speechrecognitioncore", Prefix),
        ("com.apple.speech.", Prefix),
        ("com.apple.dictation", Prefix),
        ("com.apple.siri", Prefix),
        ("com.apple.assistantd", Prefix),
        ("com.apple.corespeech", Prefix),
        ("com.apple.accessibility.heard", Prefix),
        ("microsoft.windows.cortana_", Prefix),
        // Windows' own voice typing / voice access live in the shell package.
        ("microsoftwindows.client.cbs_", Prefix),
    ]
};

/// Dictation tools by the name their app goes by, for the ones whose bundle id
/// or exe isn't in [`IGNORED`]: a voice-typing tool holds the mic while someone
/// talks to their own computer, which is never a meeting. Matched as a
/// lowercase substring of the app name.
const DICTATION_NAMES: &[&str] = &[
    "typeless",
    "wispr",
    "superwhisper",
    "macwhisper",
    "aqua voice",
    "voiceink",
    "willow voice",
    "spokenly",
    "monologue",
    "dragon",
];

fn is_dictation_name(name: &str) -> bool {
    let name = name.to_lowercase();
    DICTATION_NAMES.iter().any(|d| name.contains(d))
}

fn matches(id: &str, pattern: &str, how: Match) -> bool {
    match how {
        Match::Prefix => id.starts_with(pattern),
        Match::Exact => id == pattern,
    }
}

/// Name a mic user, or None when it is not something to ask about (Parley,
/// a dictation tool, a background daemon that is not an app). Pure.
pub fn identify(holder: &Holder) -> Option<MicApp> {
    let (id, app_name) = match holder {
        Holder::Unidentified => {
            return Some(MicApp {
                app_id: String::new(),
                app_name: String::new(),
                kind: AppKind::Unknown,
            })
        }
        Holder::Process { id, app_name } => (id.trim().to_lowercase(), app_name),
    };
    if id.is_empty()
        || IGNORED.iter().any(|(p, how)| matches(&id, p, *how))
        || app_name.as_deref().is_some_and(is_dictation_name)
    {
        return None;
    }
    if let Some((_, _, canonical, name, kind)) =
        KNOWN.iter().find(|(p, how, ..)| matches(&id, p, *how))
    {
        return Some(MicApp {
            app_id: (*canonical).to_string(),
            app_name: (*name).to_string(),
            kind: *kind,
        });
    }
    let name = app_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())?;
    Some(MicApp {
        app_id: id,
        app_name: name.to_string(),
        kind: AppKind::App,
    })
}

/// The app a macOS executable belongs to: the outermost `.app` bundle on its
/// path, without the extension (`/Applications/Google Chrome.app/…/Google
/// Chrome Helper.app/…` → "Google Chrome"). None outside any bundle. Pure.
#[cfg(any(target_os = "macos", test))]
pub fn app_name_from_path(path: &str) -> Option<String> {
    path.split('/')
        .find_map(|part| part.strip_suffix(".app"))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// A `NonPackaged` consent-store key is the exe's full path with `#` for `\`
/// (`C:#Program Files#Zoom#bin#Zoom.exe`). Returns that path and the exe's
/// file name. Pure.
#[cfg(any(target_os = "windows", test))]
pub fn decode_nonpackaged_key(key: &str) -> (String, String) {
    let path = key.replace('#', "\\");
    let exe = path.rsplit('\\').next().unwrap_or_default().to_string();
    (path, exe)
}

/// A name to show for a Windows exe: its file name without `.exe`. Pure.
#[cfg(any(target_os = "windows", test))]
pub fn exe_display_name(exe: &str) -> String {
    let lower = exe.to_lowercase();
    if lower.ends_with(".exe") {
        exe[..exe.len() - 4].to_string()
    } else {
        exe.to_string()
    }
}

/// A name to show for a packaged Windows app from its package family name
/// (`5319275A.WhatsAppDesktop_cv1g1gvanyjgm` → "WhatsAppDesktop"). Pure.
#[cfg(any(target_os = "windows", test))]
pub fn packaged_display_name(family: &str) -> String {
    let name = family.split('_').next().unwrap_or(family);
    name.rsplit('.').next().unwrap_or(name).to_string()
}

/// What Parley itself is doing with the mic right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    /// Nothing that matters.
    Idle,
    /// Recording a meeting: a call that starts now is already being recorded,
    /// so it is not asked about — not even after the recording stops.
    Recording,
    /// Dictating (or the mic test): hold the question until it is done.
    Dictating,
}

impl Busy {
    fn from_owner(owner: Option<MicUser>) -> Self {
        match owner {
            Some(MicUser::Meeting) => Busy::Recording,
            Some(MicUser::VoiceTyping | MicUser::MicTest) => Busy::Dictating,
            None => Busy::Idle,
        }
    }
}

/// What the tracker tells the frontend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    Detected(MicApp),
    Ended(MicApp),
}

struct Track {
    app: MicApp,
    /// When the current continuous hold began.
    held_since: Duration,
    /// When the app let go, while it stays away (None while it holds).
    released_at: Option<Duration>,
    /// This mic session has been decided: asked, muted, or already recorded.
    settled: bool,
    /// A prompt is up for it (so its release is reported).
    announced: bool,
}

/// The trigger state machine: one prompt per continuous mic session of an
/// app, after [`HOLD`], re-armed only once the app has left the mic alone for
/// [`REARM`]. Times are offsets from any fixed origin. Pure.
#[derive(Default)]
pub struct Tracker {
    apps: HashMap<String, Track>,
}

impl Tracker {
    /// Feed one poll: who holds the mic at `now`, what Parley is doing, and
    /// which app ids the user muted (lowercase). Returns what to announce.
    pub fn tick(
        &mut self,
        now: Duration,
        holding: &[MicApp],
        busy: Busy,
        muted: &[String],
    ) -> Vec<Signal> {
        let mut out = Vec::new();
        let mut seen: Vec<&str> = Vec::with_capacity(holding.len());
        for app in holding {
            if seen.contains(&app.app_id.as_str()) {
                continue;
            }
            seen.push(&app.app_id);
            let track = self
                .apps
                .entry(app.app_id.clone())
                .or_insert_with(|| Track {
                    app: app.clone(),
                    held_since: now,
                    released_at: None,
                    settled: false,
                    announced: false,
                });
            track.app = app.clone();
            if track.released_at.take().is_some() && !track.settled {
                // A short gap before it was decided: the hold starts over.
                track.held_since = now;
            }
            if track.settled || now.saturating_sub(track.held_since) < HOLD {
                continue;
            }
            match busy {
                Busy::Dictating => {}
                Busy::Recording => track.settled = true,
                Busy::Idle => {
                    track.settled = true;
                    if !muted.iter().any(|m| m.eq_ignore_ascii_case(&app.app_id)) {
                        track.announced = true;
                        out.push(Signal::Detected(app.clone()));
                    }
                }
            }
        }
        for (id, track) in self.apps.iter_mut() {
            if seen.contains(&id.as_str()) || track.released_at.is_some() {
                continue;
            }
            track.released_at = Some(now);
            if std::mem::take(&mut track.announced) {
                out.push(Signal::Ended(track.app.clone()));
            }
        }
        self.apps.retain(|_, t| {
            t.released_at
                .is_none_or(|at| now.saturating_sub(at) < REARM)
        });
        out
    }

    /// Forget everything announced, returning the apps whose prompt is up.
    fn drain_announced(&mut self) -> Vec<MicApp> {
        let out = self
            .apps
            .values()
            .filter(|t| t.announced)
            .map(|t| t.app.clone())
            .collect();
        self.apps.clear();
        out
    }
}

/// Who is using the mic right now, other than Parley. `exact` is false when
/// the OS could only say "someone" (then Parley's own capture looks the same).
struct Poll {
    holders: Vec<Holder>,
    exact: bool,
}

fn poll_mic() -> Poll {
    #[cfg(target_os = "macos")]
    {
        macos::mic_holders()
    }
    #[cfg(target_os = "windows")]
    {
        Poll {
            holders: windows::mic_holders(),
            exact: true,
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Poll {
            holders: Vec::new(),
            exact: true,
        }
    }
}

/// The running watcher, if any.
#[derive(Default)]
pub struct MeetingDetectState {
    stop: Mutex<Option<Arc<AtomicBool>>>,
    muted: Arc<Mutex<Vec<String>>>,
}

/// Start, stop or update the watcher. The frontend calls it with the
/// setting at startup and whenever the setting or the muted list changes.
#[tauri::command]
pub fn set_meeting_detection(
    app: AppHandle,
    state: State<'_, MeetingDetectState>,
    enabled: bool,
    muted_apps: Vec<String>,
) {
    *state.muted.lock().unwrap() = muted_apps.iter().map(|m| m.to_lowercase()).collect();
    let mut running = state.stop.lock().unwrap();
    if !enabled {
        if let Some(stop) = running.take() {
            log::info!("meeting-detect: stopped");
            stop.store(true, Ordering::SeqCst);
        }
        return;
    }
    if running.is_some() || cfg!(not(any(target_os = "macos", target_os = "windows"))) {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let muted = state.muted.clone();
    let thread_stop = stop.clone();
    let spawned = std::thread::Builder::new()
        .name("meeting-detect".into())
        .spawn(move || watch(app, thread_stop, muted));
    match spawned {
        Ok(_) => {
            log::info!("meeting-detect: started");
            *running = Some(stop);
        }
        Err(e) => log::error!("meeting-detect: watcher not started: {e}"),
    }
}

fn watch(app: AppHandle, stop: Arc<AtomicBool>, muted: Arc<Mutex<Vec<String>>>) {
    let origin = Instant::now();
    let mut tracker = Tracker::default();
    while !stop.load(Ordering::SeqCst) {
        let owner = app.state::<MicCoordinator>().owner();
        let poll = poll_mic();
        // "Someone uses the mic" while Parley captures could just be Parley.
        let holding: Vec<MicApp> = if !poll.exact && owner.is_some() {
            Vec::new()
        } else {
            poll.holders.iter().filter_map(identify).collect()
        };
        let muted_now = muted.lock().unwrap().clone();
        let signals = tracker.tick(
            origin.elapsed(),
            &holding,
            Busy::from_owner(owner),
            &muted_now,
        );
        for signal in signals {
            let (event, app_info) = match signal {
                Signal::Detected(a) => (DETECTED_EVENT, a),
                Signal::Ended(a) => (ENDED_EVENT, a),
            };
            log::info!(
                "meeting-detect: {event} {} ({:?})",
                app_info.app_id,
                app_info.kind
            );
            let _ = app.emit(event, &app_info);
        }
        // Sleep in slices so a stop takes effect promptly.
        let until = Instant::now() + POLL;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    for app_info in tracker.drain_announced() {
        let _ = app.emit(ENDED_EVENT, &app_info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(id: &str, name: Option<&str>) -> Holder {
        Holder::Process {
            id: id.into(),
            app_name: name.map(Into::into),
        }
    }

    fn zoom() -> MicApp {
        identify(&proc("us.zoom.xos", Some("zoom.us"))).unwrap()
    }

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn known_apps_get_friendly_names_and_kinds() {
        let z = zoom();
        assert_eq!((z.app_name.as_str(), z.kind), ("Zoom", AppKind::App));
        let chrome = identify(&proc("com.google.Chrome.helper", Some("Google Chrome"))).unwrap();
        assert_eq!(chrome.app_id, "com.google.chrome");
        assert_eq!(chrome.kind, AppKind::Browser);
        let teams = identify(&proc("MS-Teams.exe", Some("ms-teams"))).unwrap();
        assert_eq!(teams.app_name, "Microsoft Teams");
        let wa = identify(&proc("5319275A.WhatsAppDesktop_cv1g1gvanyjgm", None)).unwrap();
        assert_eq!(wa.app_name, "WhatsApp");
        let edge = identify(&proc("msedge.exe", Some("msedge"))).unwrap();
        assert_eq!(edge.kind, AppKind::Browser);
        let ft = identify(&proc("com.apple.avconferenced", None)).unwrap();
        assert_eq!(ft.app_name, "FaceTime");
    }

    #[test]
    fn unknown_apps_use_their_own_name() {
        let a = identify(&proc("com.example.Recorder", Some("Recorder"))).unwrap();
        assert_eq!(a.app_id, "com.example.recorder");
        assert_eq!(a.app_name, "Recorder");
        assert_eq!(a.kind, AppKind::App);
    }

    #[test]
    fn daemons_outside_an_app_are_not_asked_about() {
        assert_eq!(identify(&proc("com.apple.somedaemon", None)), None);
    }

    #[test]
    fn parley_and_dictation_tools_are_ignored() {
        for id in [
            "com.pathors.parley",
            "parley.exe",
            "com.electron.wispr-flow",
            "com.superduper.superwhisper",
            "com.apple.SpeechRecognitionCore.speechrecognitiond",
            "com.apple.siri.embeddedspeech",
            "Wispr Flow.exe",
            "now.typeless.desktop",
            "Typeless.exe",
        ] {
            assert_eq!(identify(&proc(id, Some("X"))), None, "{id}");
        }
    }

    #[test]
    fn dictation_tools_are_ignored_by_name_too() {
        for name in ["Typeless", "Aqua Voice", "VoiceInk", "MacWhisper", "Dragon Professional"] {
            assert_eq!(identify(&proc("com.example.unlisted", Some(name))), None, "{name}");
        }
        // A meeting app whose name merely shares letters is still asked about.
        assert!(identify(&proc("com.example.dragonfly", Some("Zoomie Calls"))).is_some());
    }

    #[test]
    fn an_unidentified_user_is_unknown() {
        let a = identify(&Holder::Unidentified).unwrap();
        assert_eq!(a.kind, AppKind::Unknown);
        assert!(a.app_id.is_empty());
    }

    #[test]
    fn app_name_is_the_outermost_bundle() {
        assert_eq!(
            app_name_from_path(
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
            )
            .as_deref(),
            Some("Google Chrome")
        );
        assert_eq!(
            app_name_from_path("/Applications/zoom.us.app/Contents/MacOS/zoom.us").as_deref(),
            Some("zoom.us")
        );
        assert_eq!(app_name_from_path("/usr/libexec/avconferenced"), None);
    }

    #[test]
    fn nonpackaged_keys_decode_to_a_path_and_exe() {
        let (path, exe) = decode_nonpackaged_key("C:#Program Files#Zoom#bin#Zoom.exe");
        assert_eq!(path, r"C:\Program Files\Zoom\bin\Zoom.exe");
        assert_eq!(exe, "Zoom.exe");
        assert_eq!(exe_display_name(&exe), "Zoom");
        assert_eq!(exe_display_name("Tool"), "Tool");
        assert_eq!(
            packaged_display_name("Microsoft.SkypeApp_kzf8qxf38zc2e"),
            "SkypeApp"
        );
    }

    #[test]
    fn a_hold_is_announced_after_five_seconds_once() {
        let mut t = Tracker::default();
        let z = zoom();
        let held = [z.clone()];
        assert!(t.tick(S(0), &held, Busy::Idle, &[]).is_empty());
        assert!(t.tick(S(3), &held, Busy::Idle, &[]).is_empty());
        assert_eq!(
            t.tick(S(6), &held, Busy::Idle, &[]),
            vec![Signal::Detected(z.clone())]
        );
        assert!(t.tick(S(9), &held, Busy::Idle, &[]).is_empty());
        assert_eq!(t.tick(S(12), &[], Busy::Idle, &[]), vec![Signal::Ended(z)]);
    }

    #[test]
    fn a_short_blip_is_not_a_call() {
        let mut t = Tracker::default();
        let held = [zoom()];
        t.tick(S(0), &held, Busy::Idle, &[]);
        t.tick(S(3), &[], Busy::Idle, &[]);
        // Back again: the five seconds start over.
        assert!(t.tick(S(6), &held, Busy::Idle, &[]).is_empty());
        assert!(t.tick(S(9), &held, Busy::Idle, &[]).is_empty());
        assert_eq!(t.tick(S(12), &held, Busy::Idle, &[]).len(), 1);
    }

    #[test]
    fn rejoining_a_call_asks_again() {
        let mut t = Tracker::default();
        let held = [zoom()];
        t.tick(S(0), &held, Busy::Idle, &[]);
        assert_eq!(t.tick(S(6), &held, Busy::Idle, &[]).len(), 1);
        // A blip of one poll (a device switch) is the same call.
        t.tick(S(9), &[], Busy::Idle, &[]);
        assert!(t.tick(S(12), &held, Busy::Idle, &[]).is_empty());
        assert!(t.tick(S(20), &held, Busy::Idle, &[]).is_empty());
        // Leaving and joining again is a new call: asked again.
        t.tick(S(23), &[], Busy::Idle, &[]);
        t.tick(S(30), &[], Busy::Idle, &[]);
        t.tick(S(33), &held, Busy::Idle, &[]);
        assert_eq!(t.tick(S(39), &held, Busy::Idle, &[]).len(), 1);
    }

    #[test]
    fn muted_apps_are_never_announced() {
        let mut t = Tracker::default();
        let held = [zoom()];
        let muted = vec!["US.ZOOM.XOS".to_string()];
        t.tick(S(0), &held, Busy::Idle, &muted);
        assert!(t.tick(S(6), &held, Busy::Idle, &muted).is_empty());
        // Nothing was up, so nothing ends either.
        assert!(t.tick(S(9), &[], Busy::Idle, &muted).is_empty());
    }

    #[test]
    fn a_call_that_starts_while_recording_is_not_asked_about() {
        let mut t = Tracker::default();
        let held = [zoom()];
        t.tick(S(0), &held, Busy::Recording, &[]);
        assert!(t.tick(S(6), &held, Busy::Recording, &[]).is_empty());
        // Recording stopped mid-call: still not asked.
        assert!(t.tick(S(9), &held, Busy::Idle, &[]).is_empty());
    }

    #[test]
    fn dictation_only_defers_the_question() {
        let mut t = Tracker::default();
        let held = [zoom()];
        t.tick(S(0), &held, Busy::Dictating, &[]);
        assert!(t.tick(S(6), &held, Busy::Dictating, &[]).is_empty());
        assert_eq!(t.tick(S(9), &held, Busy::Idle, &[]).len(), 1);
    }

    #[test]
    fn each_app_is_tracked_on_its_own() {
        let mut t = Tracker::default();
        let chrome = identify(&proc("com.google.chrome", None)).unwrap();
        t.tick(S(0), &[zoom()], Busy::Idle, &[]);
        t.tick(S(3), &[zoom(), chrome.clone()], Busy::Idle, &[]);
        assert_eq!(
            t.tick(S(6), &[zoom(), chrome.clone()], Busy::Idle, &[]),
            vec![Signal::Detected(zoom())]
        );
        assert_eq!(
            t.tick(S(9), &[zoom(), chrome.clone()], Busy::Idle, &[]),
            vec![Signal::Detected(chrome)]
        );
    }
}
