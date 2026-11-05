//! Who a macOS notification says it is from. tauri-plugin-notification names
//! the sender before each notification it shows, and in a dev build it names
//! Terminal, so reminders and the call prompt arrived with Terminal's icon.
//! The sender can be named only once per process (later calls are refused),
//! so Parley names itself at startup, before the plugin ever does: every
//! notification then carries Parley's icon, in dev and in the shipped app
//! alike. A dev build borrows the installed app's identity, so clicking one
//! of its notifications may open the installed Parley.

/// Name the app with `identifier` as the notification sender, once.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub(crate) fn claim(identifier: &str) {
    #[cfg(target_os = "macos")]
    if let Err(error) = notify_rust::set_application(identifier) {
        log::debug!("notifications: could not name {identifier} as the sender: {error}");
    }
}
