//! Hold-a-modifier push-to-talk, decided from raw key transitions.
//!
//! The Windows low-level keyboard hook (see `windows_hook.rs`) sees every key
//! press and release in the session, one at a time, and has to turn that
//! stream into "start dictating" / "stop dictating" for the one right-hand
//! modifier the user picked. That decision is pure bookkeeping, so it lives
//! here, free of Win32, and is unit-tested on every platform — the hook itself
//! can only run on Windows.
//!
//! The rules match the macOS event tap:
//!
//! - trigger down → [`Action::Start`], trigger up → [`Action::Stop`];
//! - auto-repeat is ignored: a low-level hook reports a held key as a stream of
//!   key-downs with no repeat flag (`LLKHF_*` has none), so "already down" is
//!   tracked here instead;
//! - a trigger pressed while another modifier is already held is a chord, not
//!   a dictation (Shift+RightCtrl, LeftCtrl+RightAlt…): it is ignored for as
//!   long as it stays held;
//! - any other key pressed while dictating turns the hold into a chord
//!   (RightCtrl+C is a copy, not a dictation): dictation stops right there and
//!   the eventual release of the trigger does nothing;
//! - except Esc while the frontend has the cancel armed: that is
//!   [`Action::Cancel`] instead of a stop, and the hook swallows the Esc (a
//!   Ctrl+Esc would open Start). The trigger's release is silent, as for any
//!   chord.
//!
//! **AltGr.** On keyboard layouts that have an AltGr key (German, French,
//! Polish, …) the right Alt key is AltGr, and Windows reports every AltGr
//! transition as a *pair*: a synthesized left Ctrl followed by the real right
//! Alt. The synthesized left Ctrl carries the scan code `0x21D` — the left
//! Ctrl scan code `0x1D` with bit `0x200` set, which no physical key produces —
//! so it is recognised by that bit and dropped. The pair therefore reads as a
//! lone right Alt: it starts dictation when right Alt is the trigger, and it
//! counts as one other modifier (right Alt) when right Ctrl is the trigger.

/// `VK_LCONTROL` … `VK_RWIN`: the modifier virtual-key codes a low-level hook
/// reports. Unlike window messages, which say `VK_CONTROL` for either side,
/// `KBDLLHOOKSTRUCT::vkCode` always names the side. Plain numbers so this file
/// compiles without the `windows` crate.
pub const VK_LSHIFT: u32 = 0xA0;
pub const VK_RSHIFT: u32 = 0xA1;
pub const VK_LCONTROL: u32 = 0xA2;
pub const VK_RCONTROL: u32 = 0xA3;
pub const VK_LMENU: u32 = 0xA4;
pub const VK_RMENU: u32 = 0xA5;
pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
/// `VK_ESCAPE`: cancels an armed dictation (see [`Action::Cancel`]).
pub const VK_ESCAPE: u32 = 0x1B;

/// Every modifier whose being held turns a trigger press into a chord. The
/// index of a key in this list is its bit in [`ModifierPtt::held`].
const MODIFIER_VKS: [u32; 8] = [
    VK_LCONTROL,
    VK_RCONTROL,
    VK_LMENU,
    VK_RMENU,
    VK_LSHIFT,
    VK_RSHIFT,
    VK_LWIN,
    VK_RWIN,
];

/// The scan-code bit Windows sets on the left Ctrl it synthesizes for AltGr.
const ALTGR_SCAN_FLAG: u32 = 0x200;

/// The right-hand modifiers that can be held as a push-to-talk key on Windows.
/// Left-hand keys are deliberately absent — they are part of every ordinary
/// shortcut, so holding one to dictate would collide constantly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    RightCtrl,
    RightAlt,
}

impl Trigger {
    /// The Settings picker id → trigger. The ids are the ones macOS already
    /// stores, so a key reads the same on both platforms: `right-control` is
    /// the right Ctrl key, and `right-option` is the key in the same place on a
    /// PC keyboard, right Alt. `fn` and `right-command` have no Windows key.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "right-control" => Some(Self::RightCtrl),
            "right-option" => Some(Self::RightAlt),
            _ => None,
        }
    }

    /// The picker id, for logs.
    pub fn id(self) -> &'static str {
        match self {
            Self::RightCtrl => "right-control",
            Self::RightAlt => "right-option",
        }
    }

    fn vk(self) -> u32 {
        match self {
            Self::RightCtrl => VK_RCONTROL,
            Self::RightAlt => VK_RMENU,
        }
    }
}

/// One key transition, as a low-level keyboard hook reports it.
#[derive(Clone, Copy, Debug)]
pub struct KeyEvent {
    /// Side-specific virtual-key code (`KBDLLHOOKSTRUCT::vkCode`).
    pub vk: u32,
    /// Hardware scan code (`KBDLLHOOKSTRUCT::scanCode`); only consulted to
    /// recognise the left Ctrl that AltGr synthesizes.
    pub scan_code: u32,
    /// A release (`LLKHF_UP`), otherwise a press or an auto-repeat.
    pub up: bool,
}

/// What the push-to-talk session should do after a key transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Start,
    Stop,
    /// End the dictation WITHOUT delivering it (Esc while armed). The hook
    /// swallows this key, and the trigger's release that follows is silent.
    Cancel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    /// The trigger is up.
    #[default]
    Idle,
    /// The trigger is held and dictation is running.
    Dictating,
    /// The trigger is held but is part of a chord; its release is ignored.
    Chord,
}

/// Turns key transitions into push-to-talk start/stop for one trigger key.
#[derive(Debug, Default)]
pub struct ModifierPtt {
    trigger: Option<Trigger>,
    /// Bitset over [`MODIFIER_VKS`]: the non-trigger modifiers currently held.
    held: u8,
    phase: Phase,
    /// The frontend has a dictation it can cancel (`CANCEL_ARMED`).
    cancel_armed: bool,
}

fn modifier_bit(vk: u32) -> Option<u8> {
    MODIFIER_VKS.iter().position(|&m| m == vk).map(|i| 1u8 << i)
}

fn is_altgr_companion(ev: KeyEvent) -> bool {
    ev.vk == VK_LCONTROL && ev.scan_code & ALTGR_SCAN_FLAG != 0
}

impl ModifierPtt {
    /// Select the key to watch (`None` watches nothing). A change forgets any
    /// in-progress hold so a key still down across the switch can't get stuck;
    /// re-selecting the same key changes nothing.
    pub fn set_trigger(&mut self, trigger: Option<Trigger>) {
        if self.trigger == trigger {
            return;
        }
        self.trigger = trigger;
        self.phase = Phase::Idle;
        if let Some(bit) = trigger.and_then(|t| modifier_bit(t.vk())) {
            self.held &= !bit;
        }
    }

    /// Whether an Esc during the hold cancels it ([`Action::Cancel`]) rather
    /// than ending it as a chord. The hook refreshes it on every key.
    pub fn set_cancel_armed(&mut self, armed: bool) {
        self.cancel_armed = armed;
    }

    /// Forget everything about held keys — used when the hook is re-armed
    /// (after sleep), since releases that happened while it was not watching
    /// were never seen. Returns [`Action::Stop`] when a dictation was running,
    /// so a release lost to the sleep can't leave the microphone open.
    pub fn reset(&mut self) -> Option<Action> {
        self.held = 0;
        let was = std::mem::take(&mut self.phase);
        (was == Phase::Dictating).then_some(Action::Stop)
    }

    /// Feed one key transition. `still_down(vk)` asks the OS whether a key is
    /// physically down right now; it is consulted only when the trigger is
    /// pressed, to drop modifiers whose release this hook never saw (a
    /// Ctrl+Alt+Del or Win+L hands the releases to the secure desktop, and
    /// without this the next dictation would read as a chord forever).
    pub fn on_key(&mut self, ev: KeyEvent, still_down: impl Fn(u32) -> bool) -> Option<Action> {
        if is_altgr_companion(ev) {
            return None;
        }
        match self.trigger {
            Some(t) if ev.vk == t.vk() && ev.up => self.trigger_up(),
            Some(t) if ev.vk == t.vk() => self.trigger_down(still_down),
            _ => self.other_key(ev),
        }
    }

    fn trigger_down(&mut self, still_down: impl Fn(u32) -> bool) -> Option<Action> {
        if self.phase != Phase::Idle {
            return None; // auto-repeat of a key that is already held
        }
        self.forget_released(still_down);
        if self.held != 0 {
            self.phase = Phase::Chord;
            return None;
        }
        self.phase = Phase::Dictating;
        Some(Action::Start)
    }

    fn trigger_up(&mut self) -> Option<Action> {
        let was = std::mem::take(&mut self.phase);
        (was == Phase::Dictating).then_some(Action::Stop)
    }

    fn other_key(&mut self, ev: KeyEvent) -> Option<Action> {
        if let Some(bit) = modifier_bit(ev.vk) {
            if ev.up {
                self.held &= !bit;
            } else {
                self.held |= bit;
            }
        }
        if ev.up || self.phase != Phase::Dictating {
            return None;
        }
        self.phase = Phase::Chord;
        if self.cancel_armed && ev.vk == VK_ESCAPE {
            return Some(Action::Cancel);
        }
        Some(Action::Stop)
    }

    fn forget_released(&mut self, still_down: impl Fn(u32) -> bool) {
        for (i, &vk) in MODIFIER_VKS.iter().enumerate() {
            let bit = 1u8 << i;
            if self.held & bit != 0 && !still_down(vk) {
                self.held &= !bit;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_C: u32 = 0x43;
    const SC_LCTRL: u32 = 0x1D;
    const SC_ALTGR_LCTRL: u32 = 0x21D;

    fn down(vk: u32) -> KeyEvent {
        KeyEvent {
            vk,
            scan_code: 0,
            up: false,
        }
    }
    fn up(vk: u32) -> KeyEvent {
        KeyEvent {
            vk,
            scan_code: 0,
            up: true,
        }
    }
    fn lctrl(scan_code: u32, up: bool) -> KeyEvent {
        KeyEvent {
            vk: VK_LCONTROL,
            scan_code,
            up,
        }
    }

    /// The OS agrees with everything the hook saw.
    fn os_agrees(_: u32) -> bool {
        true
    }

    fn machine(trigger: Trigger) -> ModifierPtt {
        let mut m = ModifierPtt::default();
        m.set_trigger(Some(trigger));
        m
    }

    fn feed(m: &mut ModifierPtt, events: &[KeyEvent]) -> Vec<Option<Action>> {
        events.iter().map(|&e| m.on_key(e, os_agrees)).collect()
    }

    #[test]
    fn press_starts_and_release_stops() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(
            feed(&mut m, &[down(VK_RCONTROL), up(VK_RCONTROL)]),
            [Some(Action::Start), Some(Action::Stop)]
        );
    }

    #[test]
    fn auto_repeat_is_ignored() {
        let mut m = machine(Trigger::RightAlt);
        assert_eq!(
            feed(
                &mut m,
                &[down(VK_RMENU), down(VK_RMENU), down(VK_RMENU), up(VK_RMENU)]
            ),
            [Some(Action::Start), None, None, Some(Action::Stop)]
        );
    }

    #[test]
    fn a_stray_release_does_nothing() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(feed(&mut m, &[up(VK_RCONTROL)]), [None]);
    }

    #[test]
    fn only_the_selected_key_triggers() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(
            feed(
                &mut m,
                &[
                    down(VK_LCONTROL),
                    up(VK_LCONTROL),
                    down(VK_RMENU),
                    up(VK_RMENU)
                ]
            ),
            [None, None, None, None]
        );
    }

    #[test]
    fn nothing_triggers_without_a_selection() {
        let mut m = ModifierPtt::default();
        assert_eq!(
            feed(&mut m, &[down(VK_RCONTROL), up(VK_RCONTROL)]),
            [None, None]
        );
    }

    #[test]
    fn a_trigger_pressed_under_another_modifier_is_a_chord() {
        let mut m = machine(Trigger::RightCtrl);
        // Shift+RightCtrl: ignored for the whole hold, repeats included.
        assert_eq!(
            feed(
                &mut m,
                &[
                    down(VK_LSHIFT),
                    down(VK_RCONTROL),
                    down(VK_RCONTROL),
                    up(VK_RCONTROL),
                    up(VK_LSHIFT)
                ]
            ),
            [None, None, None, None, None]
        );
        // Once the other modifier is gone, the trigger works again.
        assert_eq!(
            feed(&mut m, &[down(VK_RCONTROL), up(VK_RCONTROL)]),
            [Some(Action::Start), Some(Action::Stop)]
        );
    }

    #[test]
    fn a_key_pressed_during_the_hold_turns_it_into_a_chord() {
        let mut m = machine(Trigger::RightCtrl);
        // RightCtrl+C is a copy: dictation stops at the C, and the release of
        // RightCtrl afterwards is not a second stop.
        assert_eq!(
            feed(
                &mut m,
                &[
                    down(VK_RCONTROL),
                    down(VK_C),
                    down(VK_C),
                    up(VK_C),
                    up(VK_RCONTROL)
                ]
            ),
            [Some(Action::Start), Some(Action::Stop), None, None, None]
        );
    }

    #[test]
    fn a_modifier_pressed_during_the_hold_also_ends_it() {
        let mut m = machine(Trigger::RightAlt);
        assert_eq!(
            feed(
                &mut m,
                &[down(VK_RMENU), down(VK_LSHIFT), up(VK_RMENU), up(VK_LSHIFT)]
            ),
            [Some(Action::Start), Some(Action::Stop), None, None]
        );
    }

    #[test]
    fn a_key_released_during_the_hold_changes_nothing() {
        // A non-modifier key held from before (its release lands mid-hold)
        // must not end the dictation.
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(
            feed(&mut m, &[down(VK_RCONTROL), up(VK_C), up(VK_RCONTROL)]),
            [Some(Action::Start), None, Some(Action::Stop)]
        );
    }

    #[test]
    fn altgr_reads_as_right_alt() {
        let mut m = machine(Trigger::RightAlt);
        // AltGr down = synthesized LCtrl (0x21D) + RAlt; auto-repeat repeats
        // both; release sends both again.
        let events = [
            lctrl(SC_ALTGR_LCTRL, false),
            down(VK_RMENU),
            lctrl(SC_ALTGR_LCTRL, false),
            down(VK_RMENU),
            lctrl(SC_ALTGR_LCTRL, true),
            up(VK_RMENU),
        ];
        assert_eq!(
            feed(&mut m, &events),
            [
                None,
                Some(Action::Start),
                None,
                None,
                None,
                Some(Action::Stop)
            ]
        );
    }

    #[test]
    fn a_real_left_ctrl_still_blocks_right_alt() {
        let mut m = machine(Trigger::RightAlt);
        assert_eq!(
            feed(
                &mut m,
                &[lctrl(SC_LCTRL, false), down(VK_RMENU), up(VK_RMENU)]
            ),
            [None, None, None]
        );
    }

    #[test]
    fn altgr_is_another_modifier_for_a_right_ctrl_trigger() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(
            feed(
                &mut m,
                &[
                    lctrl(SC_ALTGR_LCTRL, false),
                    down(VK_RMENU),
                    down(VK_RCONTROL),
                    up(VK_RCONTROL)
                ]
            ),
            [None, None, None, None]
        );
    }

    #[test]
    fn a_release_the_hook_never_saw_does_not_block_forever() {
        let mut m = machine(Trigger::RightCtrl);
        // Ctrl+Alt+Del: the releases went to the secure desktop.
        feed(&mut m, &[down(VK_LCONTROL), down(VK_LMENU)]);
        // The OS says both keys are up by the time the trigger is pressed.
        assert_eq!(m.on_key(down(VK_RCONTROL), |_| false), Some(Action::Start));
    }

    #[test]
    fn a_modifier_the_os_still_reports_down_keeps_blocking() {
        let mut m = machine(Trigger::RightCtrl);
        feed(&mut m, &[down(VK_LWIN)]);
        assert_eq!(m.on_key(down(VK_RCONTROL), |vk| vk == VK_LWIN), None);
    }

    #[test]
    fn switching_trigger_forgets_the_hold() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(m.on_key(down(VK_RCONTROL), os_agrees), Some(Action::Start));
        m.set_trigger(Some(Trigger::RightAlt));
        // The old key's release is now just another key.
        assert_eq!(m.on_key(up(VK_RCONTROL), os_agrees), None);
        assert_eq!(
            feed(&mut m, &[down(VK_RMENU), up(VK_RMENU)]),
            [Some(Action::Start), Some(Action::Stop)]
        );
    }

    #[test]
    fn reselecting_the_same_trigger_keeps_the_hold() {
        let mut m = machine(Trigger::RightCtrl);
        m.on_key(down(VK_RCONTROL), os_agrees);
        m.set_trigger(Some(Trigger::RightCtrl));
        assert_eq!(m.on_key(up(VK_RCONTROL), os_agrees), Some(Action::Stop));
    }

    #[test]
    fn reset_stops_a_running_dictation_once() {
        let mut m = machine(Trigger::RightCtrl);
        m.on_key(down(VK_RCONTROL), os_agrees);
        assert_eq!(m.reset(), Some(Action::Stop));
        assert_eq!(m.reset(), None);
        // The release that follows is not a second stop.
        assert_eq!(m.on_key(up(VK_RCONTROL), os_agrees), None);
    }

    #[test]
    fn reset_forgets_held_modifiers() {
        let mut m = machine(Trigger::RightCtrl);
        m.on_key(down(VK_LSHIFT), os_agrees);
        assert_eq!(m.reset(), None);
        assert_eq!(m.on_key(down(VK_RCONTROL), os_agrees), Some(Action::Start));
    }

    fn armed(trigger: Trigger) -> ModifierPtt {
        let mut m = machine(trigger);
        m.set_cancel_armed(true);
        m
    }

    #[test]
    fn escape_cancels_an_armed_hold_and_its_release_is_silent() {
        let mut m = armed(Trigger::RightCtrl);
        assert_eq!(
            feed(
                &mut m,
                &[
                    down(VK_RCONTROL),
                    down(VK_ESCAPE),
                    up(VK_ESCAPE),
                    up(VK_RCONTROL)
                ]
            ),
            [Some(Action::Start), Some(Action::Cancel), None, None]
        );
        // Nothing left running for a re-arm after sleep to stop.
        assert_eq!(m.reset(), None);
    }

    #[test]
    fn escape_without_an_armed_cancel_is_an_ordinary_chord() {
        let mut m = machine(Trigger::RightCtrl);
        assert_eq!(
            feed(&mut m, &[down(VK_RCONTROL), down(VK_ESCAPE)]),
            [Some(Action::Start), Some(Action::Stop)]
        );
    }

    #[test]
    fn escape_while_idle_is_just_a_key() {
        let mut m = armed(Trigger::RightAlt);
        assert_eq!(
            feed(&mut m, &[down(VK_ESCAPE), up(VK_ESCAPE)]),
            [None, None]
        );
    }

    #[test]
    fn escape_under_a_chorded_trigger_is_not_a_cancel() {
        // Shift+RightCtrl is a chord, never a dictation, so there is nothing
        // for Esc to cancel.
        let mut m = armed(Trigger::RightCtrl);
        assert_eq!(
            feed(
                &mut m,
                &[down(VK_LSHIFT), down(VK_RCONTROL), down(VK_ESCAPE)]
            ),
            [None, None, None]
        );
    }

    #[test]
    fn a_second_escape_after_the_cancel_does_nothing() {
        let mut m = armed(Trigger::RightCtrl);
        assert_eq!(
            feed(
                &mut m,
                &[
                    down(VK_RCONTROL),
                    down(VK_ESCAPE),
                    up(VK_ESCAPE),
                    down(VK_ESCAPE)
                ]
            ),
            [Some(Action::Start), Some(Action::Cancel), None, None]
        );
    }

    #[test]
    fn picker_ids_map_to_windows_keys() {
        assert_eq!(Trigger::from_id("right-control"), Some(Trigger::RightCtrl));
        assert_eq!(Trigger::from_id("right-option"), Some(Trigger::RightAlt));
        assert_eq!(Trigger::from_id("right-command"), None);
        assert_eq!(Trigger::from_id("fn"), None);
        assert_eq!(Trigger::from_id("combo:control+alt+Space"), None);
        for t in [Trigger::RightCtrl, Trigger::RightAlt] {
            assert_eq!(Trigger::from_id(t.id()), Some(t));
        }
    }
}
