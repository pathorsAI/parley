// Build-time edition flag.
//
// The "cloud" edition (Google sign-in, history sync, organizations, and the
// hosted account features) is compiled in by default. The pure local / OSS
// edition is built with `VITE_PARLEY_CLOUD=false`, which makes this a compile-time
// `false` so Vite eliminates every `CLOUD_ENABLED &&` branch — the binary then
// ships no account/sync UI and makes no cloud calls. One codebase, two builds.
export const CLOUD_ENABLED = import.meta.env.VITE_PARLEY_CLOUD !== "false";
