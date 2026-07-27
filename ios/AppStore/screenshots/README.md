# iPhone screenshot set — Night Signal

Use only a real build on a simulator or physical iPhone. Do not place user
meeting content, real email addresses, or desktop mockups in screenshots.

## Current captured set

Four real frames are checked in, captured from build 1.0 (3) on an iPhone 17 Pro
simulator signed in as the review account, with the two sample meetings loaded:
`01-record`, `02-library`, `03-transcript`, `04-settings`. The files at the top
level are native 1206×2622; [`6.9-inch/`](6.9-inch) holds the same frames scaled
to the 6.9-inch slot's **1320×2868** (0.06% aspect delta, not visible). Upload
the `6.9-inch/` set.

Still to capture for the full story: a live in-progress recording frame and the
save-destination picker. Both need a live relay session, so shoot them during
the next device test pass.

> Driving the simulator: `xcrun simctl io <device> screenshot <path>` works on
> any booted device. The iOS Simulator MCP tool binds its input channel to the
> first device it connects to, so keep exactly one simulator booted or taps land
> on the wrong one.

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
