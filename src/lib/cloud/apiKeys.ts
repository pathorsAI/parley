// Personal API keys: let a server read this account's synced recordings through
// the cloud's read-only REST API (`/v1/recordings`, see docs/api.md). Managed with
// the normal session bearer — the cloud refuses to let a key manage keys.
//
//   GET    /me/api-keys          → { keys: ApiKey[] }
//   POST   /me/api-keys { name } → { key: ApiKey, secret }   (secret shown once)
//   DELETE /me/api-keys/:id      → { ok: true }

import { cloudFetch } from "./client";

export interface ApiKey {
  id: string;
  name: string;
  /** The secret's first characters ("prly_Ab3dE6"), to tell keys apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await cloudFetch("/me/api-keys");
  return ((await res.json()) as { keys: ApiKey[] }).keys;
}

/** Create a key. The returned `secret` is never retrievable again. */
export async function createApiKey(name: string): Promise<{ key: ApiKey; secret: string }> {
  const res = await cloudFetch("/me/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  return (await res.json()) as { key: ApiKey; secret: string };
}

export async function revokeApiKey(id: string): Promise<void> {
  await cloudFetch(`/me/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
