# Parley Cloud REST API

A read-only HTTPS API for the recordings you've synced to Parley Cloud. It's for your own servers and scripts, like a CRM integration that attaches meeting notes to deals. AI assistants are better served by the [remote MCP connector](connector-listing.md), which signs in with OAuth instead of a key.

- Base URL: `https://api.parley.tw`
- Auth: `Authorization: Bearer prly_…` (a personal API key)
- Read-only: nothing in this API creates, edits, moves or deletes a recording.

## API keys

Create one in the app: **Settings → Account → API keys**. You must be signed in, and the app only shows the secret once. Copy it right away. Parley stores only a hash of it.

A key can read what you can read:

- your personal recordings that cloud sync has uploaded, and
- the recordings shared into every organization you're a member of, for as long as you stay a member.

Revoke a key in the same place. A revoked key stops working on its next request. You can have up to 10 live keys.

## Limits and logging

- **Rate limit:** 60 requests per minute per key. Past that you get `429 rate_limited` with a `Retry-After` header (in seconds). Requests rejected with 429 don't count against the limit.
- **Access log:** every authenticated request is recorded (key, time, method, path with query, status, IP, user agent) and kept for 90 days.

## `GET /v1/recordings`

Lists recordings, newest first.

| Query | |
|---|---|
| `since` | Only recordings that started at or after this time: epoch milliseconds or ISO 8601 (`2026-10-20T08:00:00Z`). |
| `until` | Only recordings that started at or before this time. Same formats. |
| `scope` | `all` (default): personal plus every organization you belong to. `personal`: personal only. |
| `orgId` | One organization's recordings only. Returns 404 if you're not a member. |
| `limit` | Page size. Default 50, max 100. |

```bash
curl -s "https://api.parley.tw/v1/recordings?since=2026-10-20T00:00:00%2B08:00&until=2026-10-21T00:00:00%2B08:00" \
  -H "Authorization: Bearer $PARLEY_API_KEY"
```

```json
{
  "recordings": [
    {
      "id": "6f0c…",
      "title": "Whisky Cask Club intro",
      "source": "live",
      "createdAt": "2026-10-20T06:02:11.000Z",
      "createdAtMs": 1760940131000,
      "durationMs": 2712000,
      "speakerNames": ["Jack", "Alex"],
      "folder": { "id": "…", "name": "Customers" },
      "org": null,
      "analyzed": true
    }
  ],
  "hasMore": false,
  "nextUntil": null
}
```

- `createdAt` is when the recording **started**.
- `speakerNames` lists only the names someone gave speakers in the app, not default labels like "Speaker 2".
- `org` is `{ id, name }` for an organization's copy and `null` for a personal recording. A recording you shared into an org appears twice, under two different ids.
- **Paging:** when `hasMore` is true, request the next (older) page with `until=<nextUntil>`.

## `GET /v1/recordings/:id`

One recording, with Parley's saved analysis. Add `include=transcript` for the full transcript.

```bash
curl -s "https://api.parley.tw/v1/recordings/6f0c…?include=transcript" \
  -H "Authorization: Bearer $PARLEY_API_KEY"
```

The response has every field from the list, plus:

| Field | |
|---|---|
| `synced` | `false` while the recording's details are still uploading. The analysis fields below are empty until it's `true`. |
| `meetingType` | The meeting type Parley detected or you set (for example `sales`, `negotiation`), or `null`. |
| `meetingContext` | The free-text context you entered before the meeting, or `null`. |
| `brief` | The brief, as Markdown, or `null` if none has been generated. |
| `findings` | `[{ atMs, at, title, detail }]`. `at` is the `m:ss` offset into the recording. |
| `actionItems` | `[{ text, done }]` |
| `transcript` | With `include=transcript` only: `[{ atMs, at, speaker, text }]`, using the speaker names shown in the app. |

A recording you can't read (it belongs to someone else, sits in an org you're not in, or was deleted) returns 404, the same as an id that doesn't exist.

There's no web page for viewing a recording yet, so responses don't include a browser link. Open the recording in the Parley app.

## Errors

Errors are JSON shaped like `{ "error": "<code>", "message": "…" }`.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | A malformed `since`, `until`, `limit` or `scope` |
| 401 | `invalid_api_key` | No key, an unknown key, or a revoked key |
| 404 | `not_found` | No such recording or organization among yours |
| 429 | `rate_limited` | Over the per-key limit; wait `Retry-After` seconds |
