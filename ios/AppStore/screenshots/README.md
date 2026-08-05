# iPhone screenshot set — Night Signal

Use only a real build on a simulator or physical iPhone. Do not place user
meeting content, real email addresses, or desktop mockups in screenshots.

## Current captured set

Four real frames are checked in, captured from build 1.0 (3) on an iPhone 17 Pro
simulator signed in as the review account: `01-record`, `02-library`,
`03-transcript`, `04-settings`. The files at the top level are native 1206×2622;
[`6.9-inch/`](6.9-inch) holds the same frames scaled to the 6.9-inch slot's
**1320×2868** (0.06% aspect delta, not visible). Upload the `6.9-inch/` set.

### About the demo content

The library and transcript frames show two meetings — 續約條件討論 and
新客戶需求訪談 — written to read the way real B2B conversations actually sound
(seat counts, onboarding time, invoicing split, a security questionnaire).
That is deliberate: a screenshot captioned "this is a test" sells nothing and
tells a reviewer nothing about the product.

The content is **entirely fictional**. It names no real company, person, or
customer, and no real meeting data was used. Speakers are labelled 我 /
客戶窗口 via the app's own speaker-naming feature. Regenerate with
`scratchpad/seed-demo.mjs` against the review account.

The four frames are all signed-in states, so build 4's sign-in gate does not
invalidate them — they still match what the app shows once an account is in.

Four frames satisfy submission (App Store Connect requires at least one). Three
more would complete the story and are worth grabbing on the next pass:

- **welcome / sign-in** — build 4's first screen, the app's actual first
  impression and the one frame nothing in the current set covers.
- **consent + live recording** — tap Start Recording to show the consent sheet,
  confirm, then capture the red recording state with the level meter.
- **save destination** — Settings → Default save location with the picker open.

> Driving the simulator: `xcrun simctl io <device> screenshot <path>` captures
> reliably on any booted device. Input is the fragile part — the iOS Simulator
> MCP tool binds its input channel to the first device it connects to and does
> not recover after the Simulator app is restarted (`machPortNotConnected`);
> AppleScript `click at` lands on the menu bar, and posting `CGEvent`s from a
> shell needs Accessibility permission the sandbox does not have. Fastest path:
> keep exactly one simulator booted, do not restart the Simulator app mid-session,
> and if input dies, tap by hand and capture with `simctl`.

Export 5 PNG/JPEG images without alpha at one accepted iPhone size (for
example, the current 6.9-inch or 6.5-inch App Store slot shown in Connect).
Capture each after setting the same appearance and system time.

| File | App state | Story | Required visible detail |
| --- | --- | --- | --- |
| `01-live-transcript` | Recording in progress | The phone listens in the room. | Red recording signal, live transcript, stop action. |
| `02-recording-library` | Personal library | The result is kept, not ephemeral. | Several clearly synthetic recordings, duration, sync state. |
| `03-recording-detail` | Saved recording | Replay is deliberate review, not streamed text replay. | Playback control, timestamps, transcript reading surface. |
| `04-destination` | Save/move flow | The same meeting belongs in the right scope. | Personal folder and organization target labels. |
| `05-settings` | Settings | Trust and control are in the product. | Theme picker, sync state, privacy/support links. |

## Capture procedure

1. Use a dedicated reviewer/demo account and synthetic spoken content.
2. Disable notification previews and use a clean simulator state.
3. Record a short synthetic meeting so the transcript, library, and detail
   screens show actual app data.
4. Capture with `xcrun simctl io booted screenshot <path>` or the device’s
   screenshot control. Inspect pixels at 100% before upload.
5. Upload through the current App Store Connect screenshot slot; its accepted
   dimensions change over time, so treat the Connect UI as authoritative.
