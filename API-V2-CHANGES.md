# API v2 changes — contract for the native client (ImageIndex)

Everything below is implemented and covered by tests in `test/`. All routes
require the better-auth session cookie. Request `size` fields are **bytes**;
stored sizes and quota accounting are **KB** (`ceil(bytes / 1024)`) — same
quirk as v1, unchanged.

## 1. Hidden system namespace (dot-prefixed)

`GET /api/files?path=<p>` response shape is unchanged
(`{ currentPath, parentPath, items }`), but items whose `name` starts with `.`
are now **omitted** unless one of:

- query `?includeHidden=1`
- header `X-Include-Hidden: <any non-empty value>`
- the requested `path` itself is inside a dot-folder (first segment starts
  with `.`) — so navigating `?path=.imageindex/<libraryID>` lists children
  exactly as before.

Nothing else treats hidden objects specially: create/delete/download/quota all
behave normally. Create `.imageindex` with the ordinary `POST /api/files/folder`.

## 2. Folder name fidelity

`POST /api/files/folder` and `PUT /api/files/:id` no longer normalize names
(no lowercasing, no space/hyphen → `_`). Sanitization only:

- leading/trailing whitespace trimmed, trailing `/` stripped
- rejected: empty names, names containing `/`, names > 255 chars

`Vacation 2024` round-trips byte-for-byte; case, spaces, hyphens, and unicode
are preserved. Uniqueness stays exact-match on `(owner, path)` — `photos` and
`Photos` can coexist.

## 3. Batch presign — `POST /api/files/upload-urls` (new)

```jsonc
// request — 1 to 100 items
{ "items": [
  { "name": "IMG_0012.jpg", "contentType": "image/jpeg", "size": 123456,
    "parentPath": "Photos/vacation",                  // optional, default ""
    "thumbnail": { "size": 4096, "contentType": "image/webp" } }  // optional
] }

// response 200 — positional, items[i] answers request items[i]
{ "items": [
  { "url": "<presigned PUT>", "key": "<r2 key>", "thumbnailUrl": "<presigned PUT or null>" },
  { "error": "File already exists" }
] }
```

- Per-item errors (other items unaffected): `"Parent folder not found"`,
  `"File already exists"`, `"Duplicate name in batch"`.
- Whole-request `400 { "error": "Storage quota exceeded" }` when the batch
  total (files + thumbnails, in KB) + existing pending + used exceeds the
  allocation — nothing is presigned; back off and retry smaller/later.
- Whole-request `400` (zod) if any item is structurally invalid.
- One `upload_requests` row per accepted item (counts toward quota until
  committed, cancelled, or expired).
- Presigned URLs embed exact `Content-Type` + `Content-Length`, expire in 1 h.

## 4. Batch commit — `POST /api/files/batch` (new)

```jsonc
// request — 1 to 100 items, size in bytes
{ "items": [
  { "key": "<r2 key from presign>", "name": "IMG_0012.jpg",
    "contentType": "image/jpeg", "size": 123456, "parentPath": "Photos/vacation" }
] }

// response 200 — positional: the created object row, or { "error": ... }
{ "items": [
  { "id": 42, "name": "IMG_0012.jpg", "path": "Photos/vacation/IMG_0012.jpg",
    "parentPath": "Photos/vacation", "key": "…", "thumbnail": "… | null",
    "contentType": "image/jpeg", "size": 121, "createdAt": 1752878400000, "updatedAt": 1752878400000 }
] }
```

- Per-item errors: `"Invalid or expired upload request"` (unknown / already
  used / expired / duplicate key within the batch), `"Parent folder not
  found"`, `"File already exists at this path"` (existing object or duplicate
  path within the batch).
- All accepted items commit in **one atomic D1 batch**; quota (`storage_used`)
  increments by the accepted total only.
- Single-item routes (`POST /api/files/upload-url`, `POST /api/files`) are
  unchanged and remain valid.

## 5. Presign cancel — `DELETE /api/files/upload-url/:key` (new)

Cancels a presign you will not commit; frees its quota reservation
immediately and asynchronously deletes any partially-uploaded bytes
(`<key>` and `thumb/<key>`).

- `200 { "message": "Upload request cancelled" }`
- `404 { "error": "Upload request not found" }` — no *pending* request with
  that key for this user (already committed/expired/foreign keys included).

## 6. Pending-upload hygiene (lockout fix)

- Pending presigns older than **1 hour** are auto-expired on every presign
  call (single and batch) *before* the quota check, and hourly by cron. A
  killed sync can no longer lock the account out of its own quota — just call
  `upload-urls` again.
- Expired requests can never be committed (`"Invalid or expired upload
  request"`); their R2 leftovers are swept by the cron.

## 7. Thumbnails for non-image files

If the presign included a `thumbnail` spec, the committed object gets
`thumbnail` set even for non-`image/*` content types (video posters, etc.).
`GET /api/files/:key/thumbnail` (302 → signed `thumb/<key>` URL) works for
them exactly as for images. Images keep the old fallback (thumbnail set even
without a spec).

## 8. Signup default quota

New accounts get `storage_allocated = 10485760` KB (10 GB) at creation;
existing zero-quota accounts were backfilled by migration. A fresh signup can
upload immediately.

## 9. Origin policy (unchanged guarantees, now pinned by tests)

- `Origin: <BETTER_AUTH_URL>` (the API's own origin) is trusted on
  cookie-bearing auth requests — keep sending it.
- `/api/files/*` never requires an `Origin` header.
- Cookie-bearing auth POSTs from untrusted origins get
  `403 INVALID_ORIGIN`; credential-bearing, cookie-less requests
  (sign-in/sign-up) are not origin-checked by better-auth.
- Browser CORS for the web frontend is unchanged (one extra allowed header:
  `X-Include-Hidden`).

## Not implemented (phase 2 / W5)

Multipart upload for > 4.5 GB objects, bearer-token auth plugin,
content-hash dedup.
