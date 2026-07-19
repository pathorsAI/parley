import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import type { EvalDef, TimelineEvent } from "./types";

/**
 * Apply mutation commands the MCP server enqueues (add/check/remove todo,
 * add/remove evaluation) so an MCP client can change the live meeting in real
 * time. The queue file is append-only; we track a cursor of applied lines.
 *
 * Commands carrying an `id` are RPC-style: the MCP server is blocked waiting for
 * a result, so we execute them and append `{ id, ok, data|error }` to the results
 * file (`append_session_command_result`). This is how MCP tools reach things only
 * the frontend can do — cloud/org calls (auth lives here) and localStorage
 * (folders).
 */
interface SessionCommand {
  /** Present on RPC commands — the MCP server polls the results file for it. */
  id?: string;
  /** Enqueuing MCP server's endpoint. The command queue lives in the config dir,
   *  which packaged + dev instances SHARE — without this scope a mutating RPC
   *  (import_transcript!) would be executed by BOTH frontends. Absent on
   *  commands from older builds → any instance may run them (legacy behavior). */
  instance?: string;
  action: string;
  args: Record<string, unknown>;
}

// Until seeded with the existing backlog length, apply nothing (avoids
// replaying commands left over from a previous launch).
let cursor = Number.MAX_SAFE_INTEGER;
let timer: ReturnType<typeof setInterval> | null = null;
/** This instance's own MCP endpoint (see SessionCommand.instance); resolved
 *  before polling starts, null if the embedded server didn't come up. */
let ownEndpoint: string | null = null;

function lines(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Stringify a loosely-typed command argument. Real callers send strings; this
 * coerces primitives exactly as `String()` did, but JSON-encodes objects/arrays
 * instead of emitting a useless "[object Object]".
 */
function argStr(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
}

/** Coerce a loosely-shaped severity into a valid {@link TimelineEvent} severity. */
function normalizeSeverity(v: unknown): TimelineEvent["severity"] {
  if (v === "critical") return "critical";
  if (v === "warn") return "warn";
  return "info";
}

/**
 * Coerce a loosely-shaped finding (e.g. from an MCP client) into a valid
 * {@link TimelineEvent}, filling defaults and minting an id when missing. Returns
 * null only when there is no usable content at all (no title and no detail).
 */
function normalizeFinding(raw: unknown): TimelineEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title : "";
  const detail = typeof o.detail === "string" ? o.detail : "";
  if (!title.trim() && !detail.trim()) return null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : crypto.randomUUID(),
    atMs: Number.isFinite(o.atMs) ? Number(o.atMs) : 0,
    side: o.side === "me" ? "me" : "them",
    severity: normalizeSeverity(o.severity),
    source: o.source === "eval" ? "eval" : "extra",
    evalIds: Array.isArray(o.evalIds) ? o.evalIds.map(String) : undefined,
    title,
    detail,
    resolved: typeof o.resolved === "boolean" ? o.resolved : undefined,
    resolution: typeof o.resolution === "string" ? o.resolution : undefined,
  };
}

type Store = ReturnType<typeof useStore.getState>;

/** Apply the finding-mutating commands (add/set/update/remove). */
function applyFindingCommand(s: Store, action: string, a: Record<string, unknown>): void {
  switch (action) {
    case "add_finding": {
      // The whole args object IS the finding to insert.
      const finding = normalizeFinding(a);
      if (finding) s.addFinding(finding);
      break;
    }
    case "set_findings":
      if (Array.isArray(a.events)) {
        const events = a.events
          .map(normalizeFinding)
          .filter((f): f is TimelineEvent => f !== null);
        s.setFindings(events);
      }
      break;
    case "update_finding":
      if (a.id) {
        // Everything except the id is treated as a partial patch.
        const { id: _id, ...patch } = a;
        s.updateFinding(argStr(a.id), patch as Partial<TimelineEvent>);
      }
      break;
    case "remove_finding":
      if (a.id) s.removeFinding(argStr(a.id));
      break;
  }
}

function applyCommand(cmd: SessionCommand): void {
  const s = useStore.getState();
  const a = cmd.args ?? {};
  switch (cmd.action) {
    case "add_todo":
      if (a.text) s.addTodo(argStr(a.text));
      break;
    case "remove_todo":
      if (a.id) s.removeTodo(argStr(a.id));
      break;
    case "check_todo": {
      const todo = s.todos.find((t) => t.id === a.id);
      const target = a.done !== false;
      if (todo && todo.done !== target) s.toggleTodo(todo.id);
      break;
    }
    case "add_evaluation": {
      if (a.name && a.prompt) {
        const def: EvalDef = {
          id: crypto.randomUUID(),
          name: argStr(a.name),
          description: argStr(a.description ?? ""),
          prompt: argStr(a.prompt),
        };
        s.updateSettings({ evaluations: [...s.settings.evaluations, def] });
      }
      break;
    }
    case "remove_evaluation":
      if (a.id) {
        s.updateSettings({ evaluations: s.settings.evaluations.filter((e) => e.id !== a.id) });
      }
      break;
    case "add_finding":
    case "set_findings":
    case "update_finding":
    case "remove_finding":
      applyFindingCommand(s, cmd.action, a);
      break;
  }
}

/**
 * Execute an RPC command (one that carries an id) and return its result data.
 * These reach the pieces the Rust MCP server can't touch directly: cloud/org
 * HTTP calls (the bearer token lives in this process) and the localStorage
 * folder registry. Throwing here surfaces as the MCP tool's error message.
 */
async function applyRpcCommand(action: string, a: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "rename_recording": {
      const id = argStr(a.id);
      const title = argStr(a.title).trim();
      if (!id || !title) throw new Error("id and title are required");
      const { renameHistoryEntry } = await import("./history/history");
      await renameHistoryEntry(id, title);
      // If that recording is open in replay, reflect the new name immediately.
      const s = useStore.getState();
      if (s.loadedHistoryId === id) s.renameReplay(title);
      return { id, title };
    }
    case "move_recording_to_folder": {
      const id = argStr(a.id);
      if (!id) throw new Error("id is required");
      const folderId = a.folderId ? argStr(a.folderId) : null;
      const { setEntryFolder, emitHistoryUpdated } = await import("./history/history");
      await setEntryFolder(id, folderId);
      await emitHistoryUpdated(id);
      return { id, folderId };
    }
    case "list_folders": {
      // Fresh read: another INSTANCE (packaged vs dev) may have changed the
      // shared registry — MCP answers must reflect the file, not this
      // window's cache.
      const { listFoldersFresh } = await import("./history/folders");
      return (await listFoldersFresh()).map((f) => ({ id: f.id, name: f.name }));
    }
    case "list_orgs": {
      const { listMyOrgs } = await import("./cloud/orgs");
      return await listMyOrgs();
    }
    case "list_org_recordings": {
      const { listOrgRecordings } = await import("./cloud/sync");
      return await listOrgRecordings(argStr(a.orgId));
    }
    case "list_org_folders": {
      const { listOrgFolders } = await import("./cloud/folders");
      const folders = await listOrgFolders(argStr(a.orgId));
      return folders.map((f) => ({ id: f.id, name: f.name }));
    }
    case "share_recording_to_org": {
      const { shareRecordingToOrg } = await import("./cloud/sync");
      return await shareRecordingToOrg(
        argStr(a.id),
        argStr(a.orgId),
        a.folderId ? argStr(a.folderId) : null,
      );
    }
    case "move_recording_to_org": {
      const id = argStr(a.id);
      const { moveRecordingToOrg } = await import("./cloud/sync");
      const shared = await moveRecordingToOrg(id, argStr(a.orgId), a.folderId ? argStr(a.folderId) : null);
      const { emitHistoryUpdated } = await import("./history/history");
      await emitHistoryUpdated(id);
      return shared;
    }
    case "import_transcript": {
      // Text-ingest over MCP (issue #130): parse .txt transcripts and save them
      // as audio-less history entries — same pipeline as the import dialog.
      // Never touches the live store, so it's safe during a meeting.
      const paths = Array.isArray(a.paths) ? a.paths.map(argStr).filter(Boolean) : [];
      if (!paths.length) throw new Error("paths (array of absolute .txt paths) is required");
      const folderName = a.folder ? argStr(a.folder).trim() : "";
      const { listFoldersFresh, createLocalFolder, emitFoldersUpdated } = await import(
        "./history/folders"
      );
      let folderId: string | null = null;
      if (folderName) {
        // Fresh read (cross-instance registry), adopt an existing name, else create.
        const existing = (await listFoldersFresh()).find((f) => f.name === folderName);
        folderId = existing?.id ?? createLocalFolder(folderName).id;
        if (!existing) await emitFoldersUpdated().catch(() => {});
      }
      const { prepareTranscriptFile } = await import("./replay/importFiles");
      const { saveTranscriptToHistory } = await import("./history/history");
      const imported: { id: string; title: string; segments: number; format: string }[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const path of paths) {
        const file = await prepareTranscriptFile(path);
        if (!file.parsed) {
          failed.push({ path, error: file.error ?? "unreadable" });
          continue;
        }
        const id = await saveTranscriptToHistory({
          title: file.title,
          segments: file.parsed.segments,
          speakerNames: file.parsed.speakerNames,
          durationMs: file.parsed.durationMs,
          createdAt: file.createdAt,
          folderId,
        });
        if (id) imported.push({
          id,
          title: file.title,
          segments: file.parsed.segments.length,
          format: file.parsed.format,
        });
      }
      return { imported, failed, folderId, folder: folderName || null };
    }
    case "create_company_from_folder": {
      // Folder → Accounts sync: turn an imported history folder into a mini-CRM
      // company card, link the existing same-name folder, backfill companyId onto
      // that folder's recordings (the company page's meeting timeline filters by
      // companyId, not folder), and attach the profile text as a "doc" source.
      // Idempotent: an existing same-name active company is reused, not duplicated.
      const name = argStr(a.name).trim();
      if (!name) throw new Error("name is required");
      const aliases = Array.isArray(a.aliases) ? a.aliases.map(argStr).filter(Boolean) : [];
      const note = a.note ? argStr(a.note) : "";
      const folderId = a.folderId ? argStr(a.folderId) : null;
      const profileText = a.profileText ? argStr(a.profileText) : "";
      const profileName = a.profileName ? argStr(a.profileName) : "客戶輪廓";

      const { useAccounts } = await import("./accounts/store");
      const acc = useAccounts.getState();
      const existing = acc.companies.find((c) => !c.archived && c.name === name);
      const reused = !!existing;
      let company = existing;
      if (company) {
        // Reuse: refresh aliases/note without clobbering a manual edit with empties.
        const patch: Record<string, unknown> = {};
        if (aliases.length) patch.aliases = aliases;
        if (note) patch.note = note;
        if (folderId) patch.folderId = folderId;
        if (Object.keys(patch).length) acc.updateCompany(company.id, patch);
      } else {
        company = acc.addCompany({ name, note, aliases });
        if (folderId) acc.updateCompany(company.id, { folderId });
      }
      const companyId = company.id;

      // Backfill companyId onto the folder's recordings so they surface in the
      // company's meeting timeline.
      let meetingsLinked = 0;
      if (folderId) {
        const { listHistory, setEntryCompany } = await import("./history/history");
        const summaries = await listHistory();
        for (const s of summaries) {
          if (s.folderId === folderId && s.companyId !== companyId) {
            await setEntryCompany(s.id, companyId);
            meetingsLinked++;
          }
        }
      }

      // Attach the profile as a doc source (skip if one with this name exists).
      let attached = false;
      if (profileText.trim()) {
        const dup = useAccounts
          .getState()
          .attachments.some((at) => at.companyId === companyId && at.name === profileName);
        if (!dup) {
          useAccounts.getState().addAttachment({
            companyId,
            name: profileName,
            kind: "doc",
            text: profileText,
          });
          attached = true;
        }
      }
      return { companyId, name, folderId, meetingsLinked, attached, reused };
    }
    case "copy_org_recording_to_personal": {
      const id = argStr(a.id);
      const { saveOrgRecordingToPersonal } = await import("./cloud/sync");
      await saveOrgRecordingToPersonal(argStr(a.orgId), id);
      const { emitHistoryUpdated } = await import("./history/history");
      await emitHistoryUpdated(id);
      return { id };
    }
    default:
      throw new Error(`unknown command: ${action}`);
  }
}

/** Report an RPC command's outcome for the MCP server to pick up. */
async function writeResult(id: string, result: { ok: boolean; data?: unknown; error?: string }): Promise<void> {
  try {
    await invoke("append_session_command_result", { json: JSON.stringify({ id, ...result }) });
  } catch (e) {
    console.warn("[session] result write failed", e);
  }
}

async function poll(): Promise<void> {
  try {
    const all = lines(await invoke<string>("read_session_commands"));
    if (all.length <= cursor) return;
    const fresh = all.slice(cursor);
    cursor = all.length;
    for (const line of fresh) {
      let cmd: SessionCommand;
      try {
        cmd = JSON.parse(line) as SessionCommand;
      } catch {
        continue; // skip a malformed line
      }
      // Another instance's command (shared config-dir queue) — ITS frontend
      // executes and answers it; running it here too would double-apply.
      if (cmd.instance && ownEndpoint && cmd.instance !== ownEndpoint) continue;
      if (cmd.id) {
        try {
          const data = await applyRpcCommand(cmd.action, cmd.args ?? {});
          await writeResult(cmd.id, { ok: true, data });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await writeResult(cmd.id, { ok: false, error });
        }
      } else {
        try {
          applyCommand(cmd);
        } catch {
          /* skip a failing command */
        }
      }
    }
  } catch {
    /* read failed; try again next tick */
  }
}

/** Start polling the MCP command queue. Returns a teardown function. */
export function initSessionCommands(): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  // Seed the cursor from the existing backlog AND learn this instance's own MCP
  // endpoint, THEN start polling — so commands appended after this snapshot are
  // applied, the backlog is skipped, and instance-scoped commands are never
  // misjudged during a startup race.
  const seedCursor = invoke<string>("read_session_commands")
    .then((raw) => {
      cursor = lines(raw).length;
    })
    .catch(() => {
      cursor = 0;
    });
  const seedEndpoint = invoke<{ endpoint?: string }>("get_mcp_server_info")
    .then((info) => {
      ownEndpoint = info.endpoint || null;
    })
    .catch(() => {
      ownEndpoint = null;
    });
  // The MCP server emits this right after enqueuing a command. It's the PRIMARY
  // delivery path: macOS suspends an occluded window's JS timers, so the poll
  // interval alone can stall past the server's 20s RPC deadline (observed
  // during the first bulk import). The interval stays as the fallback sweep.
  let unlistenKick: UnlistenFn | null = null;
  const seedKick = listen("session://commands", () => {
    void poll();
  }).then((u) => {
    if (cancelled) u();
    else unlistenKick = u;
  });
  Promise.allSettled([seedCursor, seedEndpoint, seedKick]).then(() => {
    if (!cancelled) timer = setInterval(poll, 1500);
  });
  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
    unlistenKick?.();
  };
}
