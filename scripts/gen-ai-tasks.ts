// Writes shared/ai-tasks/tasks.generated.json — Parley Cloud's AI task
// registry — from the desktop's own prompt builders (src/lib/ai/tasks/registry.ts).
//
//   bun run gen:ai-tasks
//
// Runs under vite-node so the app's modules load exactly as they do in the
// unit suite (JSON imports, import.meta.env). tests/aiTasks.test.ts fails while
// the committed file differs from what this would write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTaskRegistry,
  serializeTaskRegistry,
  TASK_REGISTRY_PATH,
  type TaskRegistry,
} from "../src/lib/ai/tasks/registry";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const path = join(root, TASK_REGISTRY_PATH);
const previous: TaskRegistry | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const text = serializeTaskRegistry(await buildTaskRegistry(previous));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, text);
console.log(`wrote ${TASK_REGISTRY_PATH} (${text.length} bytes)`);
