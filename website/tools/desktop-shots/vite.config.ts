// Screenshot harness build for the Parley desktop UI.
//
// Builds the REAL app frontend (`<repo>/src/main.tsx`) behind a thin harness
// entry (`app/harness.tsx`) that fakes the Tauri IPC with fictional demo data
// and drives the store into a scene. The app source is only read; the build
// writes to ./dist (gitignored).
//
//   ../../../node_modules/.bin/vite build --config vite.config.ts
//
// PARLEY_REPO defaults to the repository this harness lives in
// (website/tools/desktop-shots → ../../..); point it elsewhere to shoot
// another checkout.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const HERE = __dirname;
const REPO = path.resolve(process.env.PARLEY_REPO ?? path.join(HERE, "../../.."));
const REPO_SRC = path.join(REPO, "src");

/**
 * Tailwind v4's automatic class detection scans the Vite root — which is this
 * harness dir, not the repo. Point it at the repo's `src/` by appending an
 * `@source` to the app stylesheet as it is loaded (the file on disk is untouched).
 */
function tailwindSourceRepo(): Plugin {
  const target = path.join(REPO_SRC, "index.css");
  return {
    name: "harness:tailwind-source-repo",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0] !== target) return null;
      return `${code}\n@source "${REPO_SRC}";\n`;
    },
  };
}

export default defineConfig({
  root: path.join(HERE, "app"),
  base: "./",
  plugins: [tailwindSourceRepo(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": REPO_SRC,
      "@repo": REPO_SRC,
    },
  },
  define: {
    // Build the Parley Cloud shape (hosted transcription, sign-in) by default, as
    // the store builds are. VITE_PARLEY_CLOUD=false shoots the OSS/local shape.
    "import.meta.env.VITE_PARLEY_CLOUD": JSON.stringify(process.env.VITE_PARLEY_CLOUD ?? "true"),
  },
  build: {
    outDir: path.join(HERE, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
  logLevel: "warn",
});
