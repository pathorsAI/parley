import { version } from "../../../package.json";
import { desktopPlatform } from "../platform";

/**
 * This build's `X-Parley-Client` value, `<os>/<version>` — the same shape the
 * Rust STT client sends (src-tauri/src/transcription/parley.rs:
 * `std::env::consts::OS` / `CARGO_PKG_VERSION`), so Parley Cloud reads one
 * format whichever side of the app is calling. `version` is package.json's,
 * which the release script bumps together with the crate's.
 */
export function parleyClientHeader(): string {
  return `${desktopPlatform()}/${version}`;
}
