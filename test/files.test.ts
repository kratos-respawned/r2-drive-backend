import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runStorageCleanup } from "../src/lib/cleanup";
import { DEFAULT_STORAGE_ALLOCATED_KB } from "../src/lib/constants";
import {
  BASE_URL,
  PASSWORD,
  bucketKeys,
  clearBucket,
  createTestUser,
  filesApi,
  getObjectPaths,
  getStorageUsed,
  getUploadRequestStatus,
  insertObject,
  insertUploadRequest,
  setupOutboundMocks,
} from "./helpers";

// created once per file: the user survives across tests (beforeAll storage
// frame), while each test's own DB writes are rolled back automatically
let userId: string;
let cookie: string;
let api: ReturnType<typeof filesApi>;

beforeAll(async () => {
  setupOutboundMocks();
  const user = await createTestUser(1000);
  userId = user.userId;
  cookie = user.cookie;
  api = filesApi(cookie);
});

// each test starts from an empty drive, empty bucket, and a fresh quota
beforeEach(async () => {
  await env.db_r2_drive.prepare("DELETE FROM objects").run();
  await env.db_r2_drive.prepare("DELETE FROM upload_requests").run();
  await env.db_r2_drive.prepare("UPDATE user SET storage_used = 0").run();
  await clearBucket();
});

describe("auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/files/`);
    expect(res.status).toBe(401);
  });
});

describe("folders", () => {
  it("creates a folder preserving its exact name", async () => {
    const res = await api.createFolder("Vacation 2024");
    expect(res.status).toBe(201);
    const folder = (await res.json()) as { name: string; path: string; parentPath: string };
    expect(folder.name).toBe("Vacation 2024");
    expect(folder.path).toBe("Vacation 2024");
    expect(folder.parentPath).toBe("");

    const list = (await (await api.list()).json()) as { items: { name: string; path: string }[] };
    expect(list.items.map((item) => item.path)).toContain("Vacation 2024");
  });

  it("preserves case, hyphens, and unicode in folder names", async () => {
    const name = "Été-2024 München";
    const res = await api.createFolder(name);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { path: string }).path).toBe(name);
  });

  it("strips trailing slashes from folder names", async () => {
    const res = await api.createFolder("Vacation 2024/");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { path: string }).path).toBe("Vacation 2024");
  });

  it("creates nested folders", async () => {
    await api.createFolder("docs");
    const res = await api.createFolder("sub", "docs");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { path: string }).path).toBe("docs/sub");
  });

  it("rejects duplicate folders", async () => {
    await api.createFolder("docs");
    const res = await api.createFolder("docs");
    expect(res.status).toBe(400);
  });

  it("rejects a missing parent folder", async () => {
    const res = await api.createFolder("sub", "ghost");
    expect(res.status).toBe(404);
  });

  it("rejects names containing '/'", async () => {
    const res = await api.createFolder("a/b");
    expect(res.status).toBe(400);
  });
});

describe("hidden system namespace", () => {
  const listPaths = async (path?: string, opts?: { includeHidden?: boolean }) => {
    const body = (await (await api.list(path, opts)).json()) as { items: { path: string }[] };
    return body.items.map((item) => item.path).sort();
  };

  beforeEach(async () => {
    await api.createFolder("Photos");
    await api.createFolder(".imageindex");
    await api.createFolder("lib1", ".imageindex");
    await insertObject({
      ownerId: userId,
      name: "manifest.json",
      path: ".imageindex/lib1/manifest.json",
      parentPath: ".imageindex/lib1",
      key: "k-manifest",
      contentType: "application/json",
    });
  });

  it("hides dot-prefixed items from the root listing", async () => {
    expect(await listPaths()).toEqual(["Photos"]);
  });

  it("still lists children when navigating directly into a dot-folder", async () => {
    expect(await listPaths(".imageindex")).toEqual([".imageindex/lib1"]);
    expect(await listPaths(".imageindex/lib1")).toEqual([".imageindex/lib1/manifest.json"]);
  });

  it("shows everything with includeHidden=1", async () => {
    expect(await listPaths(undefined, { includeHidden: true })).toEqual([".imageindex", "Photos"]);
  });

  it("shows everything when the X-Include-Hidden header is sent", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/files`, {
      headers: { Cookie: cookie, Origin: BASE_URL, "X-Include-Hidden": "1" },
    });
    const body = (await res.json()) as { items: { path: string }[] };
    expect(body.items.map((item) => item.path).sort()).toEqual([".imageindex", "Photos"]);
  });
});

describe("uploads", () => {
  it("issues an upload url and confirms the file", async () => {
    const urlRes = await api.uploadUrl({ name: "a.txt", contentType: "text/plain", size: 10 * 1024 });
    expect(urlRes.status).toBe(200);
    const { url, key } = (await urlRes.json()) as { url: string; key: string };
    expect(url).toContain(key);

    const confirm = await api.confirm({ key, name: "a.txt", contentType: "text/plain", size: 10 * 1024 });
    expect(confirm.status).toBe(201);
    const file = (await confirm.json()) as { path: string; size: number };
    expect(file.path).toBe("a.txt");
    expect(file.size).toBe(10);

    expect(await getStorageUsed(userId)).toBe(10);
    expect(await getUploadRequestStatus(key)).toBe("completed");
  });

  it("records a thumbnail for non-image files when one was presigned", async () => {
    const urlRes = await api.uploadUrl({
      name: "clip.mp4",
      contentType: "video/mp4",
      size: 10 * 1024,
      thumbnail: { size: 1024, contentType: "image/webp" },
    });
    expect(urlRes.status).toBe(200);
    const { key, thumbnailUrl } = (await urlRes.json()) as { key: string; thumbnailUrl: string };
    expect(thumbnailUrl).toContain("thumb");

    const confirm = await api.confirm({ key, name: "clip.mp4", contentType: "video/mp4", size: 10 * 1024 });
    expect(confirm.status).toBe(201);
    expect(((await confirm.json()) as { thumbnail: string | null }).thumbnail).toBe(key);
  });

  it("records no thumbnail for non-image files without one", async () => {
    const urlRes = await api.uploadUrl({ name: "notes.txt", contentType: "text/plain", size: 1024 });
    const { key } = (await urlRes.json()) as { key: string };
    const confirm = await api.confirm({ key, name: "notes.txt", contentType: "text/plain", size: 1024 });
    expect(confirm.status).toBe(201);
    expect(((await confirm.json()) as { thumbnail: string | null }).thumbnail).toBeNull();
  });

  it("rejects a duplicate file name in the same folder", async () => {
    await insertObject({ ownerId: userId, name: "a.txt", path: "a.txt", key: "k-a" });
    const res = await api.uploadUrl({ name: "a.txt", contentType: "text/plain", size: 1024 });
    expect(res.status).toBe(400);
  });

  it("rejects uploads that exceed the quota", async () => {
    const res = await api.uploadUrl({ name: "big.bin", contentType: "application/octet-stream", size: 2000 * 1024 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Storage quota exceeded");
  });

  it("counts pending uploads against the quota", async () => {
    const first = await api.uploadUrl({ name: "one.bin", contentType: "application/octet-stream", size: 600 * 1024 });
    expect(first.status).toBe(200);
    const second = await api.uploadUrl({ name: "two.bin", contentType: "application/octet-stream", size: 600 * 1024 });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("Storage quota exceeded");
  });

  it("ignores stale pending uploads when checking the quota", async () => {
    // a killed sync stranded a phantom pending upload that fills the whole quota
    await insertUploadRequest({
      ownerId: userId,
      key: "stranded-key",
      size: 1000,
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
    });

    const res = await api.uploadUrl({ name: "retry.bin", contentType: "application/octet-stream", size: 600 * 1024 });
    expect(res.status).toBe(200);
    expect(await getUploadRequestStatus("stranded-key")).toBe("expired");
  });

  it("cancels a presigned upload and frees its quota", async () => {
    const urlRes = await api.uploadUrl({ name: "abort.bin", contentType: "application/octet-stream", size: 900 * 1024 });
    const { key } = (await urlRes.json()) as { key: string };
    await env.r2_drive.put(key, "partial bytes");

    const cancel = await api.cancelUpload(key);
    expect(cancel.status).toBe(200);
    expect(await getUploadRequestStatus(key)).toBe("expired");
    await vi.waitFor(async () => {
      expect(await bucketKeys()).toEqual([]);
    });

    // the quota is free again, and the expired request can no longer be committed
    const retry = await api.uploadUrl({ name: "abort.bin", contentType: "application/octet-stream", size: 900 * 1024 });
    expect(retry.status).toBe(200);
    const confirm = await api.confirm({ key, name: "abort.bin", contentType: "application/octet-stream", size: 900 * 1024 });
    expect(confirm.status).toBe(400);
  });

  it("returns 404 when cancelling an unknown or foreign upload", async () => {
    expect((await api.cancelUpload("no-such-key")).status).toBe(404);

    const stranger = await createTestUser(1000);
    const urlRes = await filesApi(stranger.cookie).uploadUrl({ name: "s.txt", contentType: "text/plain", size: 1024 });
    const { key } = (await urlRes.json()) as { key: string };
    expect((await api.cancelUpload(key)).status).toBe(404);
    expect(await getUploadRequestStatus(key)).toBe("pending");
  });

  it("rejects an upload url into a missing folder", async () => {
    const res = await api.uploadUrl({ name: "a.txt", contentType: "text/plain", size: 1024, parentPath: "ghost" });
    expect(res.status).toBe(404);
  });

  it("rejects confirmation with an unknown key", async () => {
    const res = await api.confirm({ key: "not-a-key", name: "a.txt", contentType: "text/plain", size: 1024 });
    expect(res.status).toBe(400);
  });

  it("rejects confirmation after the parent folder was deleted", async () => {
    const folder = (await (await api.createFolder("tmp")).json()) as { id: number };
    const urlRes = await api.uploadUrl({ name: "f.txt", contentType: "text/plain", size: 1024, parentPath: "tmp" });
    const { key } = (await urlRes.json()) as { key: string };

    await api.remove(folder.id);

    const confirm = await api.confirm({ key, name: "f.txt", contentType: "text/plain", size: 1024, parentPath: "tmp" });
    expect(confirm.status).toBe(404);
  });
});

describe("batch sync", () => {
  type PresignItem = { url?: string; key?: string; thumbnailUrl?: string | null; error?: string };
  type CommitItem = { id?: number; path?: string; thumbnail?: string | null; error?: string };

  it("presigns and commits 100 items in two requests", async () => {
    await api.createFolder("Photos");
    const items = Array.from({ length: 100 }, (_, i) => ({
      name: `IMG_${String(i).padStart(4, "0")}.jpg`,
      contentType: "image/jpeg",
      size: 1024,
      parentPath: "Photos",
      thumbnail: { size: 512, contentType: "image/webp" },
    }));

    const presign = await api.uploadUrls(items);
    expect(presign.status).toBe(200);
    const presigned = ((await presign.json()) as { items: PresignItem[] }).items;
    expect(presigned).toHaveLength(100);
    expect(presigned.every((item) => item.url && item.key && item.thumbnailUrl)).toBe(true);

    const commit = await api.confirmBatch(
      items.map((item, i) => ({
        key: presigned[i].key,
        name: item.name,
        contentType: item.contentType,
        size: item.size,
        parentPath: item.parentPath,
      })),
    );
    expect(commit.status).toBe(200);
    const committed = ((await commit.json()) as { items: CommitItem[] }).items;
    expect(committed).toHaveLength(100);
    // positional: row i is the created object for request i
    committed.forEach((row, i) => {
      expect(row.path).toBe(`Photos/${items[i].name}`);
      expect(row.thumbnail).toBe(presigned[i].key);
    });

    // 100 files × 1 KB + 100 thumbnails × 1 KB pending were reserved; committed size is 100 KB
    expect(await getStorageUsed(userId)).toBe(100);
    const list = (await (await api.list("Photos")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(100);
  });

  it("fails bad items positionally without failing the batch", async () => {
    await api.createFolder("Photos");
    await insertObject({ ownerId: userId, name: "taken.jpg", path: "Photos/taken.jpg", parentPath: "Photos", key: "k-taken" });

    const presign = await api.uploadUrls([
      { name: "ok.jpg", contentType: "image/jpeg", size: 1024, parentPath: "Photos" },
      { name: "taken.jpg", contentType: "image/jpeg", size: 1024, parentPath: "Photos" },
      { name: "ok.jpg", contentType: "image/jpeg", size: 1024, parentPath: "Photos" },
      { name: "lost.jpg", contentType: "image/jpeg", size: 1024, parentPath: "ghost" },
    ]);
    expect(presign.status).toBe(200);
    const presigned = ((await presign.json()) as { items: PresignItem[] }).items;
    expect(presigned[0].url).toBeTruthy();
    expect(presigned[1].error).toBe("File already exists");
    expect(presigned[2].error).toBe("Duplicate name in batch");
    expect(presigned[3].error).toBe("Parent folder not found");
  });

  it("rejects the whole batch when it exceeds the quota", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      name: `big-${i}.bin`,
      contentType: "application/octet-stream",
      size: 400 * 1024,
    }));
    const res = await api.uploadUrls(items);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Storage quota exceeded");
  });

  it("fails bad commits positionally without failing the batch", async () => {
    const presign = await api.uploadUrls([
      { name: "a.txt", contentType: "text/plain", size: 1024 },
      { name: "b.txt", contentType: "text/plain", size: 1024 },
    ]);
    const presigned = ((await presign.json()) as { items: PresignItem[] }).items;
    await insertObject({ ownerId: userId, name: "b.txt", path: "b.txt", key: "k-race" });

    const commit = await api.confirmBatch([
      { key: presigned[0].key, name: "a.txt", contentType: "text/plain", size: 1024 },
      { key: presigned[1].key, name: "b.txt", contentType: "text/plain", size: 1024 },
      { key: "never-presigned", name: "c.txt", contentType: "text/plain", size: 1024 },
    ]);
    expect(commit.status).toBe(200);
    const committed = ((await commit.json()) as { items: CommitItem[] }).items;
    expect(committed[0].path).toBe("a.txt");
    expect(committed[1].error).toBe("File already exists at this path");
    expect(committed[2].error).toBe("Invalid or expired upload request");

    // only the successful item was committed
    expect(await getStorageUsed(userId)).toBe(1);
    expect(await getUploadRequestStatus(presigned[0].key!)).toBe("completed");
    expect(await getUploadRequestStatus(presigned[1].key!)).toBe("pending");
  });
});

describe("rename and move", () => {
  it("renames a folder and cascades to all descendants", async () => {
    const docs = (await (await api.createFolder("docs")).json()) as { id: number };
    await api.createFolder("sub", "docs");
    await insertObject({ ownerId: userId, name: "a.txt", path: "docs/a.txt", parentPath: "docs", key: "k-a", size: 10 });
    await insertObject({ ownerId: userId, name: "b.txt", path: "docs/sub/b.txt", parentPath: "docs/sub", key: "k-b", size: 20 });
    // shares the "docs" prefix without being inside the folder
    await insertObject({ ownerId: userId, name: "decoy.txt", path: "docsx/decoy.txt", parentPath: "docsx", key: "k-d", size: 5 });

    const res = await api.update(docs.id, { name: "Archive 2024", parentPath: "" });
    expect(res.status).toBe(200);
    expect(await getObjectPaths(userId)).toEqual([
      "Archive 2024",
      "Archive 2024/a.txt",
      "Archive 2024/sub",
      "Archive 2024/sub/b.txt",
      "docsx/decoy.txt",
    ]);

    const list = (await (await api.list("Archive 2024/sub")).json()) as { items: { name: string }[] };
    expect(list.items.map((item) => item.name)).toEqual(["b.txt"]);
  });

  it("rejects moving a folder into itself", async () => {
    const docs = (await (await api.createFolder("docs")).json()) as { id: number };
    await api.createFolder("sub", "docs");
    const res = await api.update(docs.id, { name: "docs", parentPath: "docs/sub" });
    expect(res.status).toBe(400);
  });

  it("rejects a name collision at the destination", async () => {
    await api.createFolder("one");
    const two = (await (await api.createFolder("two")).json()) as { id: number };
    const res = await api.update(two.id, { name: "one", parentPath: "" });
    expect(res.status).toBe(409);
  });

  it("rejects a missing destination folder", async () => {
    const one = (await (await api.createFolder("one")).json()) as { id: number };
    const res = await api.update(one.id, { name: "one", parentPath: "ghost" });
    expect(res.status).toBe(404);
  });

  it("moves a file between folders", async () => {
    await api.createFolder("dst");
    const fileId = await insertObject({ ownerId: userId, name: "f.txt", path: "f.txt", key: "k-f", size: 1 });
    const res = await api.update(fileId, { name: "f.txt", parentPath: "dst" });
    expect(res.status).toBe(200);
    expect(await getObjectPaths(userId)).toEqual(["dst", "dst/f.txt"]);
  });
});

describe("delete", () => {
  it("deletes a folder tree, reclaims quota, and cleans upload requests", async () => {
    const docs = (await (await api.createFolder("docs")).json()) as { id: number };
    await api.createFolder("sub", "docs");
    await insertObject({ ownerId: userId, name: "a.txt", path: "docs/a.txt", parentPath: "docs", key: "k1", size: 10 });
    await insertObject({
      ownerId: userId,
      name: "b.png",
      path: "docs/sub/b.png",
      parentPath: "docs/sub",
      key: "k2",
      thumbnail: "k2",
      contentType: "image/png",
      size: 20,
    });
    await insertObject({ ownerId: userId, name: "keep.txt", path: "keep.txt", key: "k3", size: 5 });
    await insertUploadRequest({ ownerId: userId, key: "k1", status: "completed", size: 10 });
    await env.db_r2_drive.prepare("UPDATE user SET storage_used = 35 WHERE id = ?").bind(userId).run();
    for (const key of ["k1", "k2", "thumb/k2", "k3"]) {
      await env.r2_drive.put(key, key);
    }

    const res = await api.remove(docs.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; deletedCount: number; freedKB: number };
    expect(body.message).toBe("Folder deleted");
    expect(body.deletedCount).toBe(4);
    expect(body.freedKB).toBe(30);

    expect(await getObjectPaths(userId)).toEqual(["keep.txt"]);
    expect(await getStorageUsed(userId)).toBe(5);
    expect(await getUploadRequestStatus("k1")).toBeNull();

    // R2 cleanup runs in waitUntil after the response
    await vi.waitFor(async () => {
      expect(await bucketKeys()).toEqual(["k3"]);
    });
  });

  it("deletes a single file", async () => {
    const fileId = await insertObject({ ownerId: userId, name: "a.txt", path: "a.txt", key: "k-a", size: 10 });
    await env.db_r2_drive.prepare("UPDATE user SET storage_used = 10 WHERE id = ?").bind(userId).run();

    const res = await api.remove(fileId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; deletedCount: number; freedKB: number };
    expect(body.message).toBe("File deleted");
    expect(body.deletedCount).toBe(1);
    expect(body.freedKB).toBe(10);
    expect(await getObjectPaths(userId)).toEqual([]);
    expect(await getStorageUsed(userId)).toBe(0);
  });

  it("returns 404 for unknown ids", async () => {
    const res = await api.remove(999999);
    expect(res.status).toBe(404);
  });
});

describe("file urls", () => {
  it("returns a signed url for files", async () => {
    const fileId = await insertObject({ ownerId: userId, name: "a.txt", path: "a.txt", key: "file-key" });
    const res = await api.fileUrl(fileId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("file-key");
  });

  it("rejects folder urls", async () => {
    const folder = (await (await api.createFolder("docs")).json()) as { id: number };
    const res = await api.fileUrl(folder.id);
    expect(res.status).toBe(400);
  });

  it("redirects to the thumbnail", async () => {
    await insertObject({
      ownerId: userId,
      name: "img.png",
      path: "img.png",
      key: "img-key",
      thumbnail: "img-key",
      contentType: "image/png",
    });
    const res = await SELF.fetch(`${BASE_URL}/api/files/img-key/thumbnail`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("thumb");
    expect(res.headers.get("location")).toContain("img-key");
  });

  it("hides other users' files", async () => {
    await insertObject({
      ownerId: userId,
      name: "img.png",
      path: "img.png",
      key: "img-key",
      thumbnail: "img-key",
      contentType: "image/png",
    });
    const stranger = await createTestUser(0);
    const res = await SELF.fetch(`${BASE_URL}/api/files/img-key/thumbnail`, {
      headers: { Cookie: stranger.cookie, Origin: BASE_URL },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});

describe("signup defaults", () => {
  it("allocates default storage so a brand-new signup can upload immediately", async () => {
    const email = `fresh-${crypto.randomUUID()}@example.com`;
    const signUp = await SELF.fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ name: "Fresh User", email, password: PASSWORD }),
    });
    expect(signUp.ok).toBe(true);

    const row = await env.db_r2_drive
      .prepare("SELECT storage_allocated FROM user WHERE email = ?")
      .bind(email)
      .first<{ storage_allocated: number }>();
    expect(row?.storage_allocated).toBe(DEFAULT_STORAGE_ALLOCATED_KB);
  });
});

describe("storage cleanup", () => {
  it("expires stale pending upload requests and deletes their uploads", async () => {
    await insertUploadRequest({
      ownerId: userId,
      key: "stale-key",
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
    });
    await insertUploadRequest({ ownerId: userId, key: "fresh-key" });
    for (const key of ["stale-key", "thumb/stale-key", "fresh-key"]) {
      await env.r2_drive.put(key, key);
    }

    await runStorageCleanup();

    expect(await getUploadRequestStatus("stale-key")).toBe("expired");
    expect(await getUploadRequestStatus("fresh-key")).toBe("pending");
    expect(await bucketKeys()).toEqual(["fresh-key"]);
  });

  it("sweeps R2 objects that nothing references", async () => {
    await insertObject({ ownerId: userId, name: "live.txt", path: "live.txt", key: "live-key", size: 1 });
    await insertUploadRequest({ ownerId: userId, key: "pending-key" });
    for (const key of ["live-key", "pending-key", "orphan-key", "thumb/orphan-key"]) {
      await env.r2_drive.put(key, key);
    }

    await runStorageCleanup();

    expect(await bucketKeys()).toEqual(["live-key", "pending-key"]);
  });
});
