# Backend plan: first-class ImageIndex sync (originals in the drive)

Audience: an agent working **only in this repo** (`r2-drive-backend`).
The native macOS client (`~/Desktop/indexer-r2`) and the web frontend
(`~/Desktop/r2-drive-web`) are consumers of this API; do not edit them, but
**do not break the web frontend** — every change here is additive or gated.

## Context — what exists today

ImageIndex is a macOS photo indexer. It indexes a local folder (EXIF, CLIP
embeddings, faces, places → one SQLite `index.db`, plus 512px thumbnails) and
currently syncs **only derived data** to this backend, as ordinary drive
objects:

```
imageindex/<libraryID>/manifest.json      merkle manifest (dir fingerprints, db hash, thumb id map)
imageindex/<libraryID>/index.db           SQLite snapshot (the whole search index)
imageindex/<libraryID>/thumbs/ab/<id>.heic
```

Other machines browse by fetching `manifest.json`, downloading `index.db`
only when its hash changed, running all queries locally, and pulling
thumbnails lazily. **Originals are never uploaded today.**

## Goal

Google-Drive semantics: the user's actual photo/video files live in the
drive too, visible and downloadable in the web UI as a normal folder tree,
openable from any machine in ImageIndex. Derived/system data (manifest,
index.db) must keep working but become **invisible to web users**.

Target namespace after this plan:

```
Photos/<Library Name>/vacation/IMG_0012.jpg    ← user-visible originals (mirror of the real folder tree)
  └─ each image/video object gets a browser-compatible thumbnail at thumb/<key> (WebP, uploaded by the client)
.imageindex/<libraryID>/manifest.json          ← hidden system namespace
.imageindex/<libraryID>/index.db
```

(The client migrates from `imageindex/` to `.imageindex/` and stops
uploading its own `thumbs/` subtree — original files' `thumb/<key>`
companions serve both the web UI and the app. Client-side work, not yours.)

## How ImageIndex uses this API differently from the web app

| | r2-drive-web (browser) | ImageIndex (native, URLSession) |
|---|---|---|
| Auth | better-auth cookie via CORS + `credentials: true`; Origin header present | Same cookie, but **no Origin header** and no CORS/preflight at all |
| Access pattern | Interactive: list one folder, upload a few files, invalidate cache | **Bulk replication**: thousands of presign→PUT→commit cycles per sync, 4–8 concurrent; listings only for self-healing |
| Change detection | None (refetch listing) | Client-side merkle diff; it never asks "what changed", it *tells* the server via delete+reupload |
| Renames/moves | Uses `PUT /:id` | Never renames — replace = `DELETE /:id` + fresh upload |
| System data | Should never see it | Reads/writes `.imageindex/**` directly **by path**, root listing not needed |
| Failure handling | Toast + retry button | Automated heal: on name collision → list parent, delete, retry; on missing manifest → full re-upload |

Consequences for you: endpoints must stay cheap and idempotent under bulk
use; per-request DB round-trips dominate sync time; interrupted syncs will
strand `pending` upload_requests at much higher volume than the web app
ever did.

## Status update — live findings (2026-07-19, tested against `wrangler dev` with real R2)

The native client has since been extended: it now mirrors **originals** into
a user-visible folder (each image with a JPEG companion PUT to the
`thumb/<key>` slot) and uses `.imageindex/` (dot-prefixed) as its system
namespace already — W1 will hide it the moment it lands.

Already landed in this repo (don't redo): parent-must-exist 404s,
`POST /folder` returning the created row (the client reads its `path`),
richer DELETE response, pending uploads counted in quota, trailing-slash
normalization.

Three defects found by exercising the real flow, now covered by W4/W6/W7
below — **all three are required**:

1. **New signups get `storage_allocated = 0`**, so every upload fails with
   "Storage quota exceeded" until someone edits the DB by hand. → W6.
2. **better-auth now rejects requests with no `Origin` header** ("Missing
   or null Origin"), which broke the native client mid-test. The client
   works around it by sending `Origin: <its base URL>`; the server must
   keep that trusted. → W7.
3. **Stranded `pending` upload_requests locked an account out of its own
   quota** during an interrupted sync; rows had to be expired by hand. →
   W4 (elevated: this happened in practice, it is not hypothetical).

## Workstreams

### W1 — Hidden system namespace (required; the "don't show manifest/db to web users" ask)

Reserve **dot-prefixed top-level folders** (any object whose `path` starts
with `.`) as system objects:

- `GET /api/files/` (listing): exclude items whose `name` starts with `.`
  **unless** the request has `?includeHidden=1` *or* the requested `path`
  itself is inside a dot-folder (direct navigation into `.imageindex/...`
  must keep working — that's how the native client reads it).
- Storage quota, delete-recursion, download URLs: unchanged — hidden ≠
  special-cased anywhere else.
- Web frontend needs zero changes: it only ever renders listings, so the
  system tree simply disappears from it.
- Add a test: root listing hides `.imageindex`; `?path=.imageindex/x`
  still lists its children; `includeHidden=1` shows everything.

### W2 — Name fidelity for folders (required for mirroring real folder trees)

`POST /api/files/folder` currently normalizes names (lowercase,
spaces/hyphens → `_`). A mirrored library folder `Vacation 2024/` must not
become `vacation_2024/` — the client's `relPath`s in index.db must match
drive paths byte-for-byte.

- Change normalization to **sanitize only**: trim trailing slashes, reject
  empty names and names containing `/`. Preserve case, spaces, hyphens,
  and unicode.
- Uniqueness stays `(owner_id, path)` exact-match. Do **not** add
  case-insensitive collision logic.
- This changes behavior for new web-created folders too (they keep their
  typed name) — that is the desired gdrive behavior. Existing rows keep
  their old normalized paths; no migration.

### W3 — Batch presign + batch commit (required for acceptable sync times)

Per-file today: `upload-url` + PUT + `commit` = 2 API calls per object.
A 30k-photo first sync = 60k Worker requests. Add batch variants:

- `POST /api/files/upload-urls`
  body `{ items: [{ name, contentType, size, parentPath, thumbnail? }] }`
  (≤ 100 per call) → `{ items: [{ url, key, thumbnailUrl } | { error }] }`,
  positional. Quota is checked against the batch total + existing pending;
  duplicate names inside the batch or vs existing objects fail that item
  only. One `upload_requests` row per accepted item.
- `POST /api/files/batch`
  body `{ items: [{ key, name, contentType, size, parentPath }] }` →
  commits each (same validation as the single route), returns the created
  rows positionally, again per-item errors, all in one D1 batch.
- Keep the single-item routes untouched (web uses them).

### W4 — Pending-upload hygiene (required; already caused a real lockout)

Quota now counts `pending` upload_requests. This locked a dev account out
during an interrupted sync (see live findings); a killed 30k-file sync
would strand gigabytes of phantom "pending" size.

- Expire pendings: on any `upload-url`/`batch` call (or a scheduled
  handler if you prefer), mark `pending` rows older than 2h as
  `expired`; only `pending` rows count toward quota (presigned URLs
  expire after 1h, so anything older can never be legitimately committed
  — but `POST /api/files` must reject commits whose request row is
  `expired`, which it already does by matching `status = "pending"`).
- Add `DELETE /api/files/upload-url/:key` — client-initiated cancel for a
  presign it will not commit (marks `expired`). Nice for clean aborts.

### W6 — Default storage allocation on signup (required)

`user.storage_allocated` defaults to 0 and nothing sets it, so a fresh
account cannot upload anything. Set a real default (e.g. 10 GB =
`10485760` KB) at user creation — better-auth `databaseHooks.user.create`
(or a Drizzle column default plus a migration backfilling existing
zero-quota users). Surface the number in one constant, not scattered.

### W7 — Origin policy must not lock out native clients (required)

better-auth's CSRF check now hard-rejects auth requests without an
`Origin` header. The native client sends `Origin: <BETTER_AUTH_URL>` (the
server's own base URL) on every API request, which better-auth trusts by
default. Guard rails:

- `BETTER_AUTH_URL` must always equal the deployed API origin, and must
  remain implicitly trusted (do not override `trustedOrigins` in a way
  that drops the base URL).
- Do not add any additional origin-checking middleware in front of
  `/api/files/*` or `/api/auth/*` that rejects missing or self origins.
- Add a test: a request with `Origin: <BETTER_AUTH_URL>` and a valid
  session cookie succeeds on sign-in, get-session, and a files route.

### W8 — Optional: honor uploaded thumbnails for non-image files

`POST /api/files` sets `objects.thumbnail = key` only when
`contentType.startsWith("image/")`, even if the client presigned and
uploaded a `thumb/<key>` companion. The native client mirrors videos too
and could give them poster previews. Change: set `thumbnail = key`
whenever the upload request included a thumbnail spec (track a
`has_thumbnail` flag on `upload_requests`), falling back to the current
image/* rule. Web UI then shows video posters with zero frontend changes.

### W5 — Optional / phase 2

- **Multipart upload** (`create-multipart`, `sign-part`, `complete`) for
  objects > 4.5 GB (R2 single-PUT limit is 5 GB; stay under it). Only
  large videos need this; per-item `size` tells you when to require it.
- **better-auth `bearer` plugin**: cookie auth already works for the
  native client, but header tokens would simplify future clients. Purely
  additive.
- **Content-hash dedup**: accept optional `contentHash` on commit, store
  it, and let a future client skip uploading bytes it already owns under
  another path. Schema: nullable `content_hash` column + index. Do not
  build cross-user dedup.

## Constraints

- Never require an `Origin` header (native clients don't send one).
- All listing/mutation semantics for non-dot paths must remain exactly as
  the web frontend expects (it parses `{ currentPath, parentPath, items }`
  and the single-route responses).
- Sizes stay KB-stored/bytes-accepted as today — the native client already
  encodes that quirk; don't "fix" it.
- Presigned URLs keep embedding exact `Content-Type` + `Content-Length`.

## Acceptance

1. Web UI root shows only user folders; `.imageindex` invisible; direct
   `?path=.imageindex/<id>` listing works with a session cookie.
2. Folder `Vacation 2024` round-trips with its exact name via create → list.
3. 100-item batch presign + batch commit succeeds in 2 requests; per-item
   duplicate errors don't fail the batch.
4. Stale pending rows stop counting toward quota (and a fresh sync after a
   killed one succeeds without manual DB surgery).
5. A brand-new signup can upload immediately (non-zero default quota).
6. Sign-in and files routes succeed with `Origin: <BETTER_AUTH_URL>`
   (native client) and with the web origin; browser CORS behavior for
   r2-drive-web is unchanged.
7. Existing r2-drive-web flows (upload with thumbnail, rename, delete,
   download) pass unchanged against the updated worker.
