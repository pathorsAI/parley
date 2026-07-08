export interface ReleaseNotes {
  version: string;
  body: string;
  url?: string;
  publishedAt?: string;
}

const LATEST_RELEASE_API = "https://api.github.com/repos/pathorsAI/parley/releases/latest";
const PENDING_NOTES_KEY = "parley.pendingReleaseNotes";
const SEEN_NOTES_KEY = "parley.seenReleaseNotesVersion";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseNotes(raw: string | null): ReleaseNotes | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReleaseNotes>;
    if (typeof value.version !== "string") return null;
    return {
      version: normalizeVersion(value.version),
      body: typeof value.body === "string" ? value.body : "",
      url: typeof value.url === "string" ? value.url : undefined,
      publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function rememberPendingReleaseNotes(notes: ReleaseNotes): void {
  storage()?.setItem(
    PENDING_NOTES_KEY,
    JSON.stringify({
      ...notes,
      version: normalizeVersion(notes.version),
    }),
  );
}

export function getPendingInstalledReleaseNotes(currentVersion: string): ReleaseNotes | null {
  const s = storage();
  if (!s) return null;
  const notes = parseNotes(s.getItem(PENDING_NOTES_KEY));
  if (!notes) return null;

  const version = normalizeVersion(currentVersion);
  const seen = normalizeVersion(s.getItem(SEEN_NOTES_KEY) ?? "");
  if (normalizeVersion(notes.version) !== version || seen === version) return null;
  return notes;
}

export function markReleaseNotesSeen(version: string): void {
  storage()?.setItem(SEEN_NOTES_KEY, normalizeVersion(version));
}

export async function fetchLatestReleaseNotes(): Promise<ReleaseNotes> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status})`);
  }

  const data = (await response.json()) as {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
  };
  const rawVersion = typeof data.tag_name === "string" ? data.tag_name : typeof data.name === "string" ? data.name : "";
  return {
    version: normalizeVersion(rawVersion),
    body: typeof data.body === "string" ? data.body : "",
    url: typeof data.html_url === "string" ? data.html_url : undefined,
    publishedAt: typeof data.published_at === "string" ? data.published_at : undefined,
  };
}
