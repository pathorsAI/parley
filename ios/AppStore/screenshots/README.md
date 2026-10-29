# iPhone screenshot set

Two locale sets, seven frames each, produced by one command (it also needs Google Chrome for the headline step):

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

Each frame is composed by [`../compose-frames.py`](../compose-frames.py) from
[`../screenshot-frames.json`](../screenshot-frames.json): a headline with one
accent word, the screen in a phone bezel, and white tags that point at what the
screen shows, on navy, brand-blue or light-grey grounds in turn. The capture
script runs the whole chain (captures, then `draw-voice-typing.py`, then the
compositor); it needs Google Chrome for the two drawing steps.

| File | Screen | Headline (zh-Hant / en-US) |
| --- | --- | --- |
| `01-record` | demo `record` | 開會不用抄，逐字稿自己長出來 / Stop taking notes. The transcript writes itself. |
| `02-voice-typing` | drawn: the keyboard dictating into a chat | 在任何 App 用說的打字 / Type by voice in any app |
| `03-summary` | demo `summary` | 會一結束，重點和待辦就整理好 / Highlights and to-dos the moment it ends |
| `04-transcript` | demo `jump` | 點一下，回到他說的那句話 / One tap back to exactly what was said |
| `05-filing` | demo `settled` | 自動取標題，幫你歸好檔 / Titled and filed for you |
| `06-library` | demo `library` | 每場會議，隨時找得到 / Every meeting, right where you left it |
| `07-desktop` | drawn: iPhone → Mac report | 手機錄下來，Mac 上深入看 / Capture on iPhone. Go deep on Mac. |

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
