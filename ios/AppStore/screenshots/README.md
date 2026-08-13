# iPhone screenshot set

Two locale sets, six frames each, produced by one command:

```bash
ios/AppStore/capture-screenshots.sh
```

| Directory | Upload to | Frames |
| --- | --- | --- |
| [`en-US/`](en-US) | English (U.S.) — the primary locale | 6 |
| [`zh-Hant/`](zh-Hant) | Traditional Chinese | 6 |

Captured on an **iPhone 17 Pro Max**, whose native 1320×2868 is exactly the App
Store 6.9-inch slot — no rescaling, no aspect drift. The script verifies the
dimensions before it exits.

| File | App state | What it has to sell |
| --- | --- | --- |
| `01-welcome` | First launch, signed out | What the app is and what an account buys, before it asks for one. |
| `02-record` | Recording in progress | The phone is listening to the room and the transcript is already there, speakers apart. |
| `03-library` | Personal library | The result is kept: titles, durations, speaker and finding counts, folders. |
| `04-transcript` | Saved recording | A transcript is a document you read and quote from, with named speakers and timestamps. |
| `05-voice-keyboard` | Settings → Voice keyboard | The 1.1 headline: dictation into any app. |
| `06-settings` | Settings | Trust and control — account, usage, sync state, appearance, language. |

## How the frames are produced

`App/Parley/ScreenshotDemo.swift` is a `#if DEBUG` demo mode. Launched with
`-ParleyDemo signedIn` the app serves fixed fictional fixtures instead of the
cloud, and it is navigated entirely by `parley://demo/…` URLs. So capturing
needs **no review account, no network, and no taps** — which is the point:

- The previous set could only be produced by signing a simulator into the live
  review account by hand. That put a real account's data one mis-tap away from a
  public screenshot, and it could never be reproduced exactly next release.
- Input automation in the Simulator is genuinely unreliable: the Simulator MCP
  tool binds its input channel to the first device it connects to and does not
  recover after the Simulator app restarts (`machPortNotConnected`), AppleScript
  `click at` lands on the menu bar, and posting `CGEvent`s from a shell needs
  Accessibility permission the sandbox does not have. `simctl openurl` has none
  of those problems.

The script also pins the status bar to 9:41 with full battery and Wi-Fi, so the
frames are consistent with each other and with every other app on the store.

Still true, and still worth keeping true: only real frames from a real build. No
mockups, no user meeting content, no real email addresses.

## About the demo content

The recordings are a renewal negotiation, a discovery call, and a quarterly
review, written the way B2B conversations actually sound — a seat count against
a quote, a price hold, an onboarding estimate with an SSO condition attached. A
screenshot captioned "test test" sells nothing and tells a reviewer nothing.

The content is **entirely fictional**: no real company, person, customer,
account, or meeting. The demo address is `alex@example.com`, in the
RFC-reserved domain. The copy is written separately in English and Traditional
Chinese rather than translated in one direction, so each store's set reads
natively.

## If you change the app

Re-run the script. That is the whole procedure. If a new screen belongs in the
set, add a route to `ScreenshotDemo.handle(_:)` and a line to `FRAMES` in the
script — do not go back to capturing by hand.
