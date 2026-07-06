import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { createRequire } from "node:module";

const host = process.env.TAURI_DEV_HOST;

// Git worktrees (.claude/worktrees/*) carry no node_modules of their own — Node
// resolves deps up-tree to the main checkout's copy, which sits outside vite's
// default fs.allow (= this root) and gets blocked (e.g. @fontsource woff2 404s
// in dev). Allow the directory deps actually resolve from; in the main checkout
// this is just ./node_modules, so it's a no-op there.
const resolvedNodeModules = path.dirname(
  path.dirname(createRequire(import.meta.url).resolve("vite/package.json")),
);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // Overriding `allow` drops the default (workspace root), so re-add it.
      allow: [__dirname, resolvedNodeModules],
    },
  },
}));
