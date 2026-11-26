export interface ReleaseNotes {
  version: string;
  body: string;
  url?: string;
  publishedAt?: string;
}

const LATEST_RELEASE_API = "https://api.github.com/repos/pathorsAI/parley/releases/latest";
const RELEASE_BY_TAG_API = "https://api.github.com/repos/pathorsAI/parley/releases/tags/";
const PENDING_NOTES_KEY = "parley.pendingReleaseNotes";
const SEEN_NOTES_KEY = "parley.seenReleaseNotesVersion";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
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

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

async function fetchRelease(url: string): Promise<ReleaseNotes> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status})`);
  }

  const data = (await response.json()) as GitHubRelease;
  let rawVersion = "";
  if (typeof data.tag_name === "string") {
    rawVersion = data.tag_name;
  } else if (typeof data.name === "string") {
    rawVersion = data.name;
  }
  return {
    version: normalizeVersion(rawVersion),
    body: typeof data.body === "string" ? data.body : "",
    url: typeof data.html_url === "string" ? data.html_url : undefined,
    publishedAt: typeof data.published_at === "string" ? data.published_at : undefined,
  };
}

export async function fetchLatestReleaseNotes(): Promise<ReleaseNotes> {
  return fetchRelease(LATEST_RELEASE_API);
}

/** The GitHub release notes for one exact version (tag `v<version>`). */
export async function fetchReleaseNotesForVersion(version: string): Promise<ReleaseNotes> {
  return fetchRelease(`${RELEASE_BY_TAG_API}v${encodeURIComponent(normalizeVersion(version))}`);
}

/**
 * The notes the post-update dialog should show, or null when there is nothing
 * to show. The update payload's body is empty whenever the feed carries no
 * `notes` (the cloud channel's latest.json didn't until v0.37.8), and a dialog
 * with only a title reads as broken — so an empty body is filled from the
 * GitHub release for that exact version, and if that is empty or unreachable
 * too, the dialog is skipped rather than opened blank.
 */
export async function resolveInstalledReleaseNotes(
  notes: ReleaseNotes,
  fetchForVersion: (version: string) => Promise<ReleaseNotes> = fetchReleaseNotesForVersion,
): Promise<ReleaseNotes | null> {
  if (notes.body.trim()) return notes;
  try {
    const fetched = await fetchForVersion(notes.version);
    if (!fetched.body.trim()) return null;
    return { ...fetched, version: notes.version };
  } catch {
    return null;
  }
}
