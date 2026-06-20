import { defineConfig } from "vitest/config";
import path from "node:path";

// Dedicated test config (kept separate from vite.config.ts so the Tauri dev
// server config isn't dragged into the test runner). Tests target the
// application + domain layer only — pure functions and the zustand store —
// so a plain Node environment is enough; no jsdom, no Tauri, no real LLM/STT.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep the native/IPC/heavy boundaries out of the unit suite entirely.
    exclude: ["node_modules/**", "src-tauri/**"],
  },
});
