# Cloud, auth and upload — public API

The `auth`, `cloud` and `upload` packages are everything the app needs to sign in
to Parley Cloud and get a finished meeting off the device. They mirror the iOS
app's contract exactly (`ios/ParleyKit/Sources/ParleyKit/CloudClient.swift`,
`ios/App/Parley/MeetingUploader.swift`); where iOS and the desktop app disagree,
iOS wins, because the phone is the precedent for a phone.

Base URL: `https://api.parley.tw` (`CloudClient.DEFAULT_BASE_URL`).
Everything is bearer-authenticated: `Authorization: Bearer <session token>`.

```
com.pathors.parley
  auth/    AuthManager, AuthCallback, CustomTabsLauncher
  cloud/   CloudClient, CloudException, CloudJson, ParleyHttp, Models.kt
  upload/  PendingUploadQueue, PendingUpload, MeetingUploader, DrainResult
```

## Wiring it up

```kotlin
val auth = AuthManager(context)          // token in Preferences DataStore
val cloud = auth.cloudClient()           // bearer + 401 → clearSession()
val uploader = MeetingUploader.create(context, cloud)
```

One `AuthManager` and one `CloudClient` per process. `ParleyHttp.shared` is the
single OkHttp client (one connection pool for auth, sync and uploads).

## Sign-in

Custom Tab → hosted page on our origin → deep link back with the token. The app
never sees a credential; Google and Apple work because the Custom Tab shares the
browser session.

```kotlin
CustomTabsLauncher.launchSignIn(context, auth)      // opens signInUrl()

// MainActivity.onCreate / onNewIntent:
when (val result = auth.handleAuthCallback(intent.data ?: return)) {
    is AuthCallback.Success -> { /* token persisted; refresh cloud.me() */ }
    is AuthCallback.Failure -> showError(result.reason)   // an error CODE, not copy
    AuthCallback.Ignored -> { /* not our URI */ }
}
```

| Member | Notes |
| --- | --- |
| `signInUrl(callback = "parley://auth-callback")` | `https://api.parley.tw/sign-in?to=<callback>`. The param is **`to`** — the backend's `validReturnTarget` (cloud `src/signin.ts`) reads `to` and allows any `parley://` target or an http loopback, falling back to `parley://auth-callback`. |
| `isAuthCallback(uri)` | `parley://auth-callback` (the manifest intent filter) and `parley://auth/…` (the iOS form) both count. |
| `handleAuthCallback(uri)` | Extracts `?token=`, persists it. `?error=` → `Failure(code)`; no token → `Failure("no_token_in_callback")`. |
| `tokenFlow: Flow<String?>` / `isSignedIn: Flow<Boolean>` | Whether a token is **stored** — not whether it is valid. |
| `currentToken(): String?` | One-shot read. |
| `saveToken(token)` | Persist directly (debug token adoption). |
| `clearSession()` | Forget locally. Wired to `CloudClient`'s 401 hook. |
| `signOut()` | Clears locally **first**, then best-effort `POST /auth/sign-out`. Desktop order: a failed revoke must never leave the app looking signed in. |

The token lives in a Preferences DataStore at
`filesDir/datastore/parley_auth.preferences_pb` — app-private, and excluded from
backup by `android:allowBackup="false"`. (iOS uses the Keychain; Android has no
equivalent that survives a reinstall, and the session is cheap to re-establish.)

**Signed-in ≠ online.** `isSignedIn` only says a token exists. Confirm with
`cloud.me()`, and sign out **only** on a 401 — a network error must keep the
session, or a subway ride looks like a logout (iOS `AppState.refreshSession()`).

## CloudClient

All methods are `suspend` and throw `CloudException` on a non-2xx response.

| Method | HTTP |
| --- | --- |
| `me(): CloudUser?` | `GET /me` → `{ user, activeOrganizationId }`. **Null user is a 200**, not an error — that is how "is this token still good?" is asked. |
| `usage(): HostedQuota` | `GET /me/usage` |
| `listRecordings(): List<RecordingSummary>` | `GET /recordings` → `{ recordings }` |
| `recordingMeta(id): RecordingMeta` | `GET /recordings/{id}/meta` |
| `downloadAudio(id, destination: File)` | `GET /recordings/{id}/audio`, streamed to disk via a `.part` file |
| `uploadAudio(id, ogg: File)` | `PUT /recordings/{id}/audio`, `Content-Type: audio/ogg`, raw file body |
| `pushRecording(id, summary, meta): Double?` | `POST /recordings/{id}` `{summary, meta}` → server `updatedAt` |
| `deleteRecording(id)` | `DELETE /recordings/{id}` |
| `refileRecording(id, folderId, summary?)` | `GET /recordings/{id}/meta`, then `POST /recordings/{id}` with the fresh meta and summary carrying the new `folderId` — an explicit `null` in **both** halves to un-file; `updatedAt` never echoed back |
| `shareRecording(id, orgId, folderId?)` | `POST /recordings/{id}/share` `{orgId, folderId?}` — server-side copy into an org. Not idempotent (a new org-side id per call) |
| `listFolders(): List<CloudFolder>` | `GET /folders` → `{ folders }` (filter `orgId == null` for the personal ones) |
| `createFolder(name, id?, createdAtMs?): CloudFolder` | `POST /folders` `{id, name, createdAt}` — the id is a client-minted lowercase UUID, so a retry re-syncs the same folder; a `{ folder }` response is used when present |
| `myOrgs(): List<CloudOrg>` | `GET /orgs/mine` → bare array, each with the caller's `role` (`owner` / `admin` / `member`); a non-array reads as none |
| `orgRecordings(orgId)` | `GET /orgs/{orgId}/recordings` → `{ recordings }` |
| `orgRecordingMeta(orgId, id)` | `GET /orgs/{orgId}/recordings/{id}/meta` |
| `orgFolders(orgId)` | `GET /orgs/{orgId}/folders` → `{ folders }` |
| `deleteOrgRecording(orgId, id)` | `DELETE /orgs/{orgId}/recordings/{id}` — uploader, owner or admin; 403 otherwise |
| `moveOrgRecordingToFolder(orgId, id, folderId?)` | `PATCH /orgs/{orgId}/recordings/{id}/folder` `{folderId}` (explicit `null` = org root) |
| `signOut()` | `POST /auth/sign-out` (prefer `AuthManager.signOut()`) |
| `deleteAccount()` | `DELETE /me` — permanent account deletion. See below. |

**Ordering rule:** audio is uploaded **before** the summary/meta push, always. A
row claiming `hasAudio` before its blob exists 404s the download on every other
device. `MeetingUploader` already does this; hand-rolled push paths must too.

**Move semantics** (the desktop's and iOS's): a personal folder move is a meta
re-push; an org folder move is the dedicated `PATCH`; "share to organization" is
`shareRecording`; "move to organization" is `shareRecording` *then*
`deleteRecording`, never the other order, so a failure half-way leaves the
original. Creating and managing organizations, and renaming or deleting folders,
are not in this client.

### Deleting the account

`deleteAccount()` erases the user row and everything cascading from it (sessions,
linked providers, usage, memberships, personal folders) plus every recording blob
under the account's R2 prefixes. Irreversible — no tombstone, nothing to restore.
Google Play requires this route in-app for any app that offers account creation;
`AccountSheet` is where it is surfaced, behind a two-step confirmation.

The session is dead when it returns, so the caller **clears** local auth rather
than signing out — there is nothing left to revoke — and empties the pending
queue, which now has no account to upload into:

```kotlin
cloud.deleteAccount()
uploadQueue.clear()
auth.clearSession()          // flips `isSignedIn` → the sign-in wall returns
```

The one refusal worth handling separately is `ownsOrganizations`: the backend
returns 409 `owned_organizations` while the account still owns a shared
workspace, because deleting it silently would take other members' recordings
with it. It has to be transferred or deleted first (today, from the desktop app).
Retrying will never clear it, so say that instead of "try again".

### Errors

`CloudException(status, message, code)` — `code` is the backend's own
`{ code }` / `{ error }`.

| Status | Property | Meaning |
| --- | --- | --- |
| 401 | `isAuthExpired` | Session is dead. `onUnauthorized` has already fired (→ `clearSession()`); show the sign-in wall. |
| 402 | `isQuotaExhausted` | Hosted quota gone. Not retryable until `HostedQuota.periodResetTs`. |
| 403 | `isForbidden` | Resource-level. **Never** sign the user out — the session is fine. |
| 404 | `isNotFound` | |
| 409 `owned_organizations` | `ownsOrganizations` | `DELETE /me` only. The account still owns a shared organization; transfer or delete it first. Never retryable. |
| 0 / 5xx / 408 / 429 | `isRetryable` | Worth another attempt. |

`status == 0` means the failure never reached HTTP (unparseable body). Plain
`IOException`s (DNS, socket) come through unwrapped.

## Uploading a finished meeting

```kotlin
val queuedId = uploader.finishAndUpload(
    audio = oggFile,                 // MOVED into the queue; do not reuse it
    title = "Meeting Aug 9, 3:20 PM",// display copy: the UI layer owns the strings
    durationMs = 92_500.0,
    segments = finals.map { TranscriptSegmentDto(it.id, it.source, it.speaker, it.text, true, it.startMs, it.endMs) },
    source = RecordingSource.LIVE,   // or UPLOAD for an imported file
)
```

- `enqueue(...)` persists `{id}.ogg` + `{id}.json` under `filesDir/PendingUploads/`
  **before** any network call and returns the id — or `null` when a *live* capture
  is shorter than 2 s (a misfire; iOS parity). An imported file is never dropped:
  importing it was explicit.
- Segments are filtered to finals, minus the tentative `"-tail"` segment.
- `drain(): DrainResult` uploads everything waiting, oldest first, 3 attempts per
  recording with 1 s / 2 s / 4 s backoff for transient failures. A non-retryable
  failure stops the pass (iOS breaks out rather than spinning a failing loop over
  the whole queue); the next drain picks up in order. Passes are serialized by an
  internal mutex, so calling it from several places is safe.
- Files are deleted **only** after both cloud steps succeed. Call `drain()` on app
  start, after sign-in, and when connectivity returns.
- `DrainResult(uploaded, remaining, discarded, failure)` — `signedOut` and
  `quotaExhausted` are convenience reads of `failure`. `discarded` counts
  manifests whose blob had vanished (unuploadable forever; they would otherwise
  block the queue head).
- `pendingCount()` backs a "N waiting to upload" badge.
- **Where it goes.** `EnqueueRequest.destination` (a `SaveDestination`) wins,
  then `EnqueueRequest.folderId` (a personal folder), then the uploader's
  `defaultDestination` — wired to `SaveLocationStore`, the account sheet's
  "Default save location". It is resolved once, at enqueue, into the manifest's
  `folderId` / `shareOrgId` / `shareFolderId`.
- **Organization destinations** upload to the personal root exactly as always and
  then run a third step, `POST /recordings/{id}/share` into the org (and org
  folder). Order: audio → push → share. A transient or 401 share failure stops
  the pass and the whole (idempotent) upload is retried later; any other 4xx is
  swallowed, leaving the recording personal-only.

`PendingUploadQueue` is the durable store on its own if you need it directly
(`list()`, `remove(id)`, `audioFile(id)`, `count()`, `bytesOnDisk()`). Its methods
do blocking I/O; `MeetingUploader` is what dispatches them.

## Wire shapes

Numbers are epoch **milliseconds** (or millisecond durations). `EpochMillisSerializer`
writes integral values as integers, so a timestamp never goes out as
`1.7236E12` the way Kotlin's default `Double` encoder would.

Nulls are **omitted** on encode (`CloudJson` uses `explicitNulls = false`),
matching Swift's `encodeIfPresent` — this is what keeps a pushed summary
byte-identical to the one iOS sends. Fields equal to their default are still
sent (`encodeDefaults = true`): `findingsCount: 0` is part of the contract.

### `summary` — `RecordingSummary`

```jsonc
{
  "id": "9f2c…",             // lowercase UUID; the recording's global id
  "title": "Meeting Aug 9, 3:20 PM",
  "source": "live",          // "live" | "upload"
  "createdAt": 1723600000123,
  "durationMs": 92500,       // fractional when the sample count says so
  "speakerCount": 2,         // distinct "{source}-{speaker}" pairs, min 1 when there is speech
  "findingsCount": 0,        // the phone does not analyze
  "actionItemsCount": 0,
  "hasAudio": true,
  "snippet": "…",            // first 3 final lines joined by " ", capped at 120 chars
  "folderId": "…"            // omitted at the personal root on upload; explicit null when un-filing
  // "updatedAt" is server-assigned; never pushed
}
```

### `meta` — the full entry (desktop `HistoryEntry`)

This is what `POST /recordings/{id}` stores in R2 and what the desktop reads back
as a history entry, so the key names are load-bearing.

```jsonc
{
  "id": "9f2c…",
  "title": "Meeting Aug 9, 3:20 PM",
  "source": "live",
  "createdAt": 1723600000123,
  "durationMs": 92500,
  "segments": [
    {
      "id": "mix-0",         // "{source}-{index}"; the "-tail" segment is never persisted
      "source": "mix",       // a phone has one mic; speaker identity comes from diarization
      "speaker": 0,          // 0 = unknown/single
      "text": "…",
      "isFinal": true,       // always true here — only finals are persisted
      "startMs": 0,
      "endMs": 4200
    }
  ],
  "speakerNames": {},        // "{source}-{speaker}" → user-assigned name
  "findings": [],
  "actionItems": [],
  "meetingContext": "",
  "meetingBatna": "",
  "meetingTarget": "",
  "meetingFloor": "",
  "audio": "audio.ogg",
  "analyzed": false,         // the findings/action-items pipeline has not run
  "folderId": "…"            // on upload, written ONLY when set — absent means the personal root.
                             // A re-file writes it always, null to un-file (RecordingMeta.withFolderId).
}
```

The analysis fields are written empty rather than omitted: the desktop reads this
object straight into a `HistoryEntry`, and `analyzed: false` is what tells it the
pipeline still owes a pass. `analyzed` cannot be inferred from the empty arrays —
a short, clean meeting legitimately analyzes to zero of both.

Reading back, `RecordingMeta` keeps the **raw** `JsonObject` rather than a typed
class, exactly as iOS keeps a dictionary: the desktop writes fields the phone
knows nothing about (`brief`, `intel`, `deliveryAssessment`, `companyId`,
`meetingType`, …) and a phone-side re-push must not silently drop them. Use
`withFolderId(...)` to change one field and keep the rest verbatim. Typed reads:
`id`, `title`, `source`, `createdAt`, `durationMs`, `analyzed`, `audio`,
`hasAudio`, `folderId`, `speakerNames`, `segments`, `speakerKey(seg)`,
`speakerName(seg)`.

Speaker *labels* ("You" / "Them" / "Speaker N") are display copy and stay in the
UI layer, which owns the bilingual string table; `speakerName()` returns only the
user-assigned name, or null.

### `GET /me/usage` — `HostedQuota`

`plan`, `sttSecondsUsed`, `sttSecondsLimit`, `llmCreditsUsed`, `llmCreditsLimit`,
`periodResetTs`, plus the derived `sttSecondsRemaining`. The server also returns
`llmTokensUsed` / `llmTokensLimit` for back-compat; iOS ignores them and so do we.

## Deviations from iOS, and why

| | iOS | Android |
| --- | --- | --- |
| Token store | Keychain | Preferences DataStore (app-private; no Android equivalent survives reinstall) |
| Callback URL | `parley://auth/cb` | `parley://auth-callback` (the manifest filter; the backend accepts any `parley://`) |
| `source` | always `"live"` | `"live"` or `"upload"` — Android imports audio files |
| Queue manifest | `{id, startedAt, durationMs, segments, defaultSave}` | `{id, title, source, startedAtMs, durationMs, segments, folderId, shareOrgId, shareFolderId}` — the title is carried (an import is named after its file, and copy belongs to the UI); `defaultSave` is flattened into the personal folder plus the org copy to make |
| Share refused after upload | 403 stops the pass (retried later) | any 4xx other than 401/408/429 is swallowed and the recording stays personal — it has already uploaded, and a stop-at-first-failure queue must not be held by a membership change |
| Short recordings | dropped under 2 s | dropped under 2 s **for live capture only** — silently discarding a file the user deliberately imported would be a bug |
| Audio upload | whole file in memory | streamed from disk |
| Retries | one attempt per drain | 3 attempts with backoff, then the pass stops (same "don't spin" rule) |
| Segment type | `ParleyKit.TranscriptSegment` | `cloud.TranscriptSegmentDto` — a wire DTO, deliberately separate from the `:parleykit` STT type so the on-the-wire names stay pinned. Map at the call site. |
