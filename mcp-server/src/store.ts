import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Source-of-truth file shared with the Parley desktop app.
 * macOS: ~/Library/Application Support/com.pathors.parley/templates.json
 */
export const TEMPLATES_PATH = path.join(
  os.homedir(),
  "Library/Application Support/com.pathors.parley/templates.json",
);

export interface EvalDef {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface EvalTemplate {
  id: string;
  name: string;
  builtin?: boolean;
  evals: EvalDef[];
}

export interface TodoTemplate {
  id: string;
  name: string;
  builtin?: boolean;
  items: string[];
}

export interface TemplatesFile {
  evalTemplates: EvalTemplate[];
  todoTemplates: TodoTemplate[];
}

const EMPTY: TemplatesFile = { evalTemplates: [], todoTemplates: [] };

/** Read the shared file. A missing/empty/invalid file is treated as empty. */
export async function readTemplates(
  filePath: string = TEMPLATES_PATH,
): Promise<TemplatesFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY, evalTemplates: [], todoTemplates: [] };
    }
    throw err;
  }
  if (!raw.trim()) return { evalTemplates: [], todoTemplates: [] };

  const data = JSON.parse(raw) as Partial<TemplatesFile>;
  return {
    evalTemplates: Array.isArray(data.evalTemplates) ? data.evalTemplates : [],
    todoTemplates: Array.isArray(data.todoTemplates) ? data.todoTemplates : [],
  };
}

/** Write the shared file (pretty-printed, 2-space), creating the dir if needed. */
export async function writeTemplates(
  data: TemplatesFile,
  filePath: string = TEMPLATES_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function newId(): string {
  return crypto.randomUUID();
}

// ---- Eval templates -------------------------------------------------------

export interface EvalTemplateSummary {
  id: string;
  name: string;
  builtin: boolean;
  evalCount: number;
}

export async function listEvalTemplates(
  filePath?: string,
): Promise<EvalTemplateSummary[]> {
  const { evalTemplates } = await readTemplates(filePath);
  return evalTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    builtin: Boolean(t.builtin),
    evalCount: Array.isArray(t.evals) ? t.evals.length : 0,
  }));
}

export async function getEvalTemplate(
  id: string,
  filePath?: string,
): Promise<EvalTemplate> {
  const { evalTemplates } = await readTemplates(filePath);
  const found = evalTemplates.find((t) => t.id === id);
  if (!found) throw new Error(`Eval template not found: ${id}`);
  return found;
}

export interface UpsertEvalInput {
  id?: string;
  name: string;
  evals: Array<{ id?: string; name: string; description: string; prompt: string }>;
}

export async function upsertEvalTemplate(
  input: UpsertEvalInput,
  filePath?: string,
): Promise<EvalTemplate> {
  const file = await readTemplates(filePath);

  const evals: EvalDef[] = input.evals.map((e) => ({
    id: e.id ?? newId(),
    name: e.name,
    description: e.description,
    prompt: e.prompt,
  }));

  const idx = input.id
    ? file.evalTemplates.findIndex((t) => t.id === input.id)
    : -1;

  let saved: EvalTemplate;
  if (idx >= 0) {
    const existing = file.evalTemplates[idx];
    saved = { ...existing, name: input.name, evals };
    file.evalTemplates[idx] = saved;
  } else {
    saved = {
      id: input.id ?? newId(),
      name: input.name,
      builtin: false,
      evals,
    };
    file.evalTemplates.push(saved);
  }

  // Preserve todoTemplates untouched.
  await writeTemplates(file, filePath);
  return saved;
}

export async function deleteEvalTemplate(
  id: string,
  filePath?: string,
): Promise<{ deleted: boolean; id: string }> {
  const file = await readTemplates(filePath);
  const before = file.evalTemplates.length;
  file.evalTemplates = file.evalTemplates.filter((t) => t.id !== id);
  const deleted = file.evalTemplates.length < before;
  if (deleted) await writeTemplates(file, filePath);
  return { deleted, id };
}

// ---- TODO templates -------------------------------------------------------

export interface TodoTemplateSummary {
  id: string;
  name: string;
  builtin: boolean;
  itemCount: number;
}

export async function listTodoTemplates(
  filePath?: string,
): Promise<TodoTemplateSummary[]> {
  const { todoTemplates } = await readTemplates(filePath);
  return todoTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    builtin: Boolean(t.builtin),
    itemCount: Array.isArray(t.items) ? t.items.length : 0,
  }));
}

export async function getTodoTemplate(
  id: string,
  filePath?: string,
): Promise<TodoTemplate> {
  const { todoTemplates } = await readTemplates(filePath);
  const found = todoTemplates.find((t) => t.id === id);
  if (!found) throw new Error(`Todo template not found: ${id}`);
  return found;
}

export interface UpsertTodoInput {
  id?: string;
  name: string;
  items: string[];
}

export async function upsertTodoTemplate(
  input: UpsertTodoInput,
  filePath?: string,
): Promise<TodoTemplate> {
  const file = await readTemplates(filePath);

  const idx = input.id
    ? file.todoTemplates.findIndex((t) => t.id === input.id)
    : -1;

  let saved: TodoTemplate;
  if (idx >= 0) {
    const existing = file.todoTemplates[idx];
    saved = { ...existing, name: input.name, items: input.items };
    file.todoTemplates[idx] = saved;
  } else {
    saved = {
      id: input.id ?? newId(),
      name: input.name,
      builtin: false,
      items: input.items,
    };
    file.todoTemplates.push(saved);
  }

  // Preserve evalTemplates untouched.
  await writeTemplates(file, filePath);
  return saved;
}

export async function deleteTodoTemplate(
  id: string,
  filePath?: string,
): Promise<{ deleted: boolean; id: string }> {
  const file = await readTemplates(filePath);
  const before = file.todoTemplates.length;
  file.todoTemplates = file.todoTemplates.filter((t) => t.id !== id);
  const deleted = file.todoTemplates.length < before;
  if (deleted) await writeTemplates(file, filePath);
  return { deleted, id };
}
