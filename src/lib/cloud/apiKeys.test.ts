import { beforeEach, describe, expect, it, vi } from "vitest";

// The API-key client: each call hits the documented cloud route with the
// session bearer, and the create call hands back the one-time secret.

const cloudFetch = vi.fn();
vi.mock("./client", () => ({ cloudFetch: (...args: unknown[]) => cloudFetch(...args) }));

const { createApiKey, listApiKeys, revokeApiKey } = await import("./apiKeys");

const KEY = { id: "k1", name: "BD hub", prefix: "prly_Ab3dE6", createdAt: 1, lastUsedAt: null };
const json = (body: unknown) => ({ json: async () => body }) as Response;

beforeEach(() => cloudFetch.mockReset());

describe("api keys client", () => {
  it("lists the caller's keys", async () => {
    cloudFetch.mockResolvedValue(json({ keys: [KEY] }));
    expect(await listApiKeys()).toEqual([KEY]);
    expect(cloudFetch).toHaveBeenCalledWith("/me/api-keys");
  });

  it("creates a key with a trimmed name and returns the secret", async () => {
    cloudFetch.mockResolvedValue(json({ key: KEY, secret: "prly_secret" }));
    expect(await createApiKey("  BD hub ")).toEqual({ key: KEY, secret: "prly_secret" });
    const [path, init] = cloudFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/me/api-keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "BD hub" });
  });

  it("revokes by id", async () => {
    cloudFetch.mockResolvedValue(json({ ok: true }));
    await revokeApiKey("k/1");
    expect(cloudFetch).toHaveBeenCalledWith("/me/api-keys/k%2F1", { method: "DELETE" });
  });
});
