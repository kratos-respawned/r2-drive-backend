import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { db } from "../db";
import { user } from "../db/auth-schema";
import { objects, uploadRequests } from "../db/file-schema";
import { chunked } from "../lib/chunk";
import { expireStalePendingUploadsQuery } from "../lib/cleanup";
import { deleteObjects, getFileUrl, getPresignedPutUrl, r2KeyToThumbnailKey } from "../lib/s3-utils";
import { authMiddleware } from "../middleware";
import { HonoEnv } from "../types";
import {
  batchCommitValidator,
  convertBytesToKB,
  createFileValidator,
  createFolderValidator,
  deleteFileValidator,
  getThumbnailValidator,
  updateFileValidator,
  uploadUrlsValidator,
  uploadUrlValidator,
} from "../validators/files";

const files = new Hono<HonoEnv>();
files.use(authMiddleware);

// D1 caps bound parameters at 100 per statement
const IN_CHUNK = 90; // 1 param per key/path in IN lists
const ROW_CHUNK = 10; // ~9 params per inserted row, with headroom

type SqliteBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

const joinPath = (parentPath: string, name: string) => (parentPath ? `${parentPath}/${name}` : name);

// escape LIKE wildcards (folder names can contain "_", which matches any character)
const isDescendantOf = (folderPath: string) => {
  const pattern = `${folderPath.replace(/[\\%_]/g, "\\$&")}/%`;
  return sql`${objects.path} LIKE ${pattern} ESCAPE '\\'`;
};

const selectFolder = (ownerId: string, path: string) =>
  db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.ownerId, ownerId), eq(objects.path, path), eq(objects.contentType, "folder")));

const parentFolderExists = async (ownerId: string, parentPath: string) => {
  if (parentPath === "") return true; // root always exists
  const folder = await selectFolder(ownerId, parentPath);
  return folder.length > 0;
};
files.get("/", async (c) => {
  const currentUser = c.get("user");
  const parentPath = c.req.query("path") ?? "";
  const normalizedPath = parentPath.replace(/\/$/, "");
  // dot-prefixed names are the reserved system namespace (e.g. .imageindex/):
  // hidden from listings unless opted in via ?includeHidden=1 or the
  // X-Include-Hidden header; direct navigation inside a dot-folder still works
  // (that's how native clients read their system data)
  const includeHidden = c.req.query("includeHidden") === "1"
    || Boolean(c.req.header("x-include-hidden"))
    || normalizedPath.startsWith(".");
  const items = await db
    .select({
      id: objects.id,
      name: objects.name,
      path: objects.path,
      size: objects.size,
      thumbnail: objects.thumbnail,
      contentType: objects.contentType,
      createdAt: objects.createdAt,
      updatedAt: objects.updatedAt,
    })
    .from(objects)
    .where(
      and(
        eq(objects.ownerId, currentUser.id),
        eq(objects.parentPath, normalizedPath),
        includeHidden ? undefined : sql`${objects.name} NOT LIKE '.%'`,
      ),
    );
  return c.json({
    currentPath: normalizedPath,
    parentPath: normalizedPath ? normalizedPath.split("/").slice(0, -1).join("/") : null,
    items,
  });
});

files.post("/upload-url", zValidator("json", uploadUrlValidator), async (c) => {
  const currentUser = c.get("user");

  const { contentType, size, name, parentPath, thumbnail } = c.req.valid("json");
  const sizeInKB = convertBytesToKB(size) + convertBytesToKB(thumbnail?.size ?? 0);
  // expiring stale pendings first keeps an interrupted sync's phantom uploads
  // from counting toward the quota in the sum below
  const [, userRows, pendingRows, existingFile, parentFolder] = await db.batch([
    expireStalePendingUploadsQuery(),
    db
      .select({ storageAllocated: user.storageAllocated, storageUsed: user.storageUsed })
      .from(user)
      .where(eq(user.id, currentUser.id)),
    db
      .select({ size: sql<number>`coalesce(sum(${uploadRequests.size}), 0)` })
      .from(uploadRequests)
      .where(and(eq(uploadRequests.ownerId, currentUser.id), eq(uploadRequests.status, "pending"))),
    db
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.ownerId, currentUser.id),
          eq(objects.name, name),
          eq(objects.parentPath, parentPath),
        ),
      ),
    selectFolder(currentUser.id, parentPath),
  ]);
  const [userData] = userRows;
  // count in-flight uploads against the quota so parallel requests can't overshoot it
  const pendingSize = pendingRows[0]?.size ?? 0;
  if (userData.storageUsed + pendingSize + sizeInKB > userData.storageAllocated) {
    return c.json({ error: "Storage quota exceeded" }, 400);
  }
  if (existingFile.length > 0) {
    return c.json({ error: "File already exists" }, 400);
  }
  if (parentPath !== "" && parentFolder.length === 0) {
    return c.json({ error: "Parent folder not found" }, 404);
  }
  const { url, key, thumbnailUrl } = await getPresignedPutUrl({ contentType, size, thumbnail });
  await db.insert(uploadRequests).values({
    ownerId: currentUser.id,
    key,
    fileName: name,
    parentPath,
    contentType,
    size: sizeInKB,
    hasThumbnail: Boolean(thumbnail),
    status: "pending",
  });
  return c.json({ url, key, thumbnailUrl });
});

// client-initiated cancel for a presign it will not commit — frees the quota
// immediately instead of waiting for the TTL expiry
files.delete("/upload-url/:key", async (c) => {
  const currentUser = c.get("user");
  const key = c.req.param("key");
  const cancelled = await db
    .update(uploadRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(uploadRequests.ownerId, currentUser.id),
        eq(uploadRequests.key, key),
        eq(uploadRequests.status, "pending"),
      ),
    )
    .returning({ key: uploadRequests.key });
  if (cancelled.length === 0) {
    return c.json({ error: "Upload request not found" }, 404);
  }
  // the client may already have PUT some bytes before aborting
  c.executionCtx.waitUntil(deleteObjects([key, r2KeyToThumbnailKey(key)]));
  return c.json({ message: "Upload request cancelled" });
});

// batch presign for bulk sync: results are positional, one per requested item;
// a bad item (duplicate name, missing parent) fails alone, but blowing the
// quota fails the whole request so the client can back off cleanly
files.post("/upload-urls", zValidator("json", uploadUrlsValidator), async (c) => {
  const currentUser = c.get("user");
  const { items } = c.req.valid("json");
  const fullPaths = items.map((item) => joinPath(item.parentPath, item.name));
  const uniquePaths = [...new Set(fullPaths)];
  const uniqueParents = [...new Set(items.map((item) => item.parentPath).filter((path) => path !== ""))];

  const pathLookups = chunked(uniquePaths, IN_CHUNK).map((chunk) =>
    db
      .select({ path: objects.path })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), inArray(objects.path, chunk)))
  );
  const parentLookups = chunked(uniqueParents, IN_CHUNK).map((chunk) =>
    db
      .select({ path: objects.path })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), inArray(objects.path, chunk), eq(objects.contentType, "folder")))
  );
  const rows = await db.batch([
    expireStalePendingUploadsQuery(),
    db
      .select({ storageAllocated: user.storageAllocated, storageUsed: user.storageUsed })
      .from(user)
      .where(eq(user.id, currentUser.id)),
    db
      .select({ size: sql<number>`coalesce(sum(${uploadRequests.size}), 0)` })
      .from(uploadRequests)
      .where(and(eq(uploadRequests.ownerId, currentUser.id), eq(uploadRequests.status, "pending"))),
    ...pathLookups,
    ...parentLookups,
  ] as SqliteBatch);
  const [, userRows, pendingRows, ...lookups] = rows as [
    unknown,
    { storageAllocated: number; storageUsed: number }[],
    { size: number }[],
    ...{ path: string }[][],
  ];
  const existingPaths = new Set(lookups.slice(0, pathLookups.length).flat().map((row) => row.path));
  const folderPaths = new Set(lookups.slice(pathLookups.length).flat().map((row) => row.path));

  type PresignItemResult = { url: string; key: string; thumbnailUrl: string | null } | { error: string };
  const results: PresignItemResult[] = Array.from({ length: items.length });
  const seenPaths = new Set<string>();
  const accepted: { index: number; sizeInKB: number }[] = [];
  items.forEach((item, index) => {
    const path = fullPaths[index];
    if (item.parentPath !== "" && !folderPaths.has(item.parentPath)) {
      results[index] = { error: "Parent folder not found" };
    } else if (existingPaths.has(path)) {
      results[index] = { error: "File already exists" };
    } else if (seenPaths.has(path)) {
      results[index] = { error: "Duplicate name in batch" };
    } else {
      seenPaths.add(path);
      accepted.push({ index, sizeInKB: convertBytesToKB(item.size) + convertBytesToKB(item.thumbnail?.size ?? 0) });
    }
  });

  const [userData] = userRows;
  const pendingSize = pendingRows[0]?.size ?? 0;
  const batchKB = accepted.reduce((total, { sizeInKB }) => total + sizeInKB, 0);
  if (userData.storageUsed + pendingSize + batchKB > userData.storageAllocated) {
    return c.json({ error: "Storage quota exceeded" }, 400);
  }

  if (accepted.length > 0) {
    // presigning is offline HMAC crypto, so doing up to 100 concurrently is cheap
    const presigned = await Promise.all(
      accepted.map(({ index }) => {
        const item = items[index];
        return getPresignedPutUrl({ contentType: item.contentType, size: item.size, thumbnail: item.thumbnail });
      }),
    );
    const requestRows = accepted.map(({ index, sizeInKB }, i) => ({
      ownerId: currentUser.id,
      key: presigned[i].key,
      fileName: items[index].name,
      parentPath: items[index].parentPath,
      contentType: items[index].contentType,
      size: sizeInKB,
      hasThumbnail: Boolean(items[index].thumbnail),
      status: "pending",
    }));
    const inserts = chunked(requestRows, ROW_CHUNK).map((chunk) => db.insert(uploadRequests).values(chunk));
    await db.batch(inserts as unknown as SqliteBatch);
    accepted.forEach(({ index }, i) => {
      const { url, key, thumbnailUrl } = presigned[i];
      results[index] = { url, key, thumbnailUrl };
    });
  }
  return c.json({ items: results });
});

files.post("/", zValidator("json", createFileValidator), async (c) => {
  const currentUser = c.get("user");
  const { key, name, contentType, parentPath, size } = c.req.valid("json");
  const fullPath = joinPath(parentPath, name);
  const [uploadRequest, existingFile, parentFolder] = await db.batch([
    db
      .select()
      .from(uploadRequests)
      .where(
        and(
          eq(uploadRequests.ownerId, currentUser.id),
          eq(uploadRequests.key, key),
          eq(uploadRequests.status, "pending"),
        ),
      ),
    db
      .select()
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), eq(objects.path, fullPath))),
    selectFolder(currentUser.id, parentPath),
  ]);
  if (uploadRequest.length === 0) {
    return c.json({ error: "Invalid or expired upload request" }, 400);
  }
  if (existingFile.length > 0) {
    return c.json({ error: "File already exists at this path" }, 409);
  }
  // the parent folder may have been deleted between the upload-url request and this call
  if (parentPath !== "" && parentFolder.length === 0) {
    return c.json({ error: "Parent folder not found" }, 404);
  }
  // a presigned thumbnail slot means the client uploaded one (video posters etc.);
  // images always get one because their thumb key falls back to the original
  const thumbnail = uploadRequest[0].hasThumbnail || contentType.startsWith("image/") ? key : null;
  // Batch insert and updates in a single round trip
  const [insertedFiles] = await db.batch([
    db
      .insert(objects)
      .values({
        ownerId: currentUser.id,
        key,
        name,
        path: fullPath,
        parentPath,
        contentType,
        size,
        thumbnail,
      })
      .returning(),
    db
      .update(uploadRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(uploadRequests.key, key)),
    db
      .update(user)
      .set({ storageUsed: sql`${user.storageUsed} + ${size}` })
      .where(eq(user.id, currentUser.id)),
  ]);

  return c.json(insertedFiles[0], 201);
});

// batch commit for bulk sync: same validation as the single route, positional
// per-item results (created row or { error }), one atomic D1 batch for all writes
files.post("/batch", zValidator("json", batchCommitValidator), async (c) => {
  const currentUser = c.get("user");
  const { items } = c.req.valid("json");
  const fullPaths = items.map((item) => joinPath(item.parentPath, item.name));
  const uniqueKeys = [...new Set(items.map((item) => item.key))];
  const uniquePaths = [...new Set(fullPaths)];
  const uniqueParents = [...new Set(items.map((item) => item.parentPath).filter((path) => path !== ""))];

  const keyLookups = chunked(uniqueKeys, IN_CHUNK).map((chunk) =>
    db
      .select()
      .from(uploadRequests)
      .where(
        and(
          eq(uploadRequests.ownerId, currentUser.id),
          eq(uploadRequests.status, "pending"),
          inArray(uploadRequests.key, chunk),
        ),
      )
  );
  const pathLookups = chunked(uniquePaths, IN_CHUNK).map((chunk) =>
    db
      .select({ path: objects.path })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), inArray(objects.path, chunk)))
  );
  const parentLookups = chunked(uniqueParents, IN_CHUNK).map((chunk) =>
    db
      .select({ path: objects.path })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), inArray(objects.path, chunk), eq(objects.contentType, "folder")))
  );
  const lookupRows = await db.batch([...keyLookups, ...pathLookups, ...parentLookups] as unknown as SqliteBatch);
  const requestByKey = new Map(
    (lookupRows.slice(0, keyLookups.length).flat() as (typeof uploadRequests.$inferSelect)[]).map(
      (row) => [row.key, row],
    ),
  );
  const pathRows = lookupRows.slice(keyLookups.length) as { path: string }[][];
  const existingPaths = new Set(pathRows.slice(0, pathLookups.length).flat().map((row) => row.path));
  const folderPaths = new Set(pathRows.slice(pathLookups.length).flat().map((row) => row.path));

  type CommitItemResult = typeof objects.$inferSelect | { error: string };
  const results: CommitItemResult[] = Array.from({ length: items.length });
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  const accepted: { index: number; row: typeof objects.$inferInsert }[] = [];
  items.forEach((item, index) => {
    const path = fullPaths[index];
    const request = requestByKey.get(item.key);
    if (!request || seenKeys.has(item.key)) {
      results[index] = { error: "Invalid or expired upload request" };
    } else if (item.parentPath !== "" && !folderPaths.has(item.parentPath)) {
      results[index] = { error: "Parent folder not found" };
    } else if (existingPaths.has(path) || seenPaths.has(path)) {
      results[index] = { error: "File already exists at this path" };
    } else {
      seenKeys.add(item.key);
      seenPaths.add(path);
      accepted.push({
        index,
        row: {
          ownerId: currentUser.id,
          key: item.key,
          name: item.name,
          path,
          parentPath: item.parentPath,
          contentType: item.contentType,
          size: item.size,
          thumbnail: request.hasThumbnail || item.contentType.startsWith("image/") ? item.key : null,
        },
      });
    }
  });

  if (accepted.length > 0) {
    const insertChunks = chunked(accepted.map(({ row }) => row), ROW_CHUNK).map((chunk) =>
      db.insert(objects).values(chunk).returning()
    );
    const completions = chunked(accepted.map(({ row }) => row.key as string), IN_CHUNK).map((chunk) =>
      db
        .update(uploadRequests)
        .set({ status: "completed", completedAt: new Date() })
        .where(and(eq(uploadRequests.ownerId, currentUser.id), inArray(uploadRequests.key, chunk)))
    );
    const totalKB = accepted.reduce((total, { row }) => total + (row.size ?? 0), 0);
    const commitRows = await db.batch([
      ...insertChunks,
      ...completions,
      db
        .update(user)
        .set({ storageUsed: sql`${user.storageUsed} + ${totalKB}` })
        .where(eq(user.id, currentUser.id)),
    ] as unknown as SqliteBatch);
    // path is unique per owner, so it maps returned rows back to their positions
    const insertedByPath = new Map(
      (commitRows.slice(0, insertChunks.length).flat() as (typeof objects.$inferSelect)[]).map(
        (row) => [row.path, row],
      ),
    );
    for (const { index } of accepted) {
      results[index] = insertedByPath.get(fullPaths[index])!;
    }
  }
  return c.json({ items: results });
});

files.delete("/:id", zValidator("param", deleteFileValidator), async (c) => {
  const { id } = c.req.valid("param");
  const currentUser = c.get("user");
  const files = await db
    .select()
    .from(objects)
    .where(and(eq(objects.ownerId, currentUser.id), eq(objects.id, id)));
  const file = files.at(0);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }
  // if there is no key, it is a folder, so its descendants must be deleted too
  const isFolder = !file.key;
  const deleteCondition = and(
    eq(objects.ownerId, currentUser.id),
    isFolder ? or(eq(objects.id, id), isDescendantOf(file.path)) : eq(objects.id, id),
  );
  const freedSizeQuery = db
    .select({ size: sql`coalesce(sum(${objects.size}), 0)` })
    .from(objects)
    .where(deleteCondition);
  const deletedKeysQuery = db
    .select({ key: objects.key })
    .from(objects)
    .where(and(deleteCondition, isNotNull(objects.key)));
  // one atomic batch: the subqueries read the rows before the final statement deletes
  // them, and .returning() reports exactly what was removed (no select/delete race)
  const [, , deleted] = await db.batch([
    db.delete(uploadRequests).where(inArray(uploadRequests.key, deletedKeysQuery)),
    db
      .update(user)
      .set({ storageUsed: sql`max(0, ${user.storageUsed} - (${freedSizeQuery}))` })
      .where(eq(user.id, currentUser.id)),
    db.delete(objects).where(deleteCondition).returning(),
  ]);

  const keys = deleted.flatMap((item) => (item.key ? [item.key] : []));
  const thumbnailKeys = deleted.flatMap((item) => (item.thumbnail ? [r2KeyToThumbnailKey(item.thumbnail)] : []));
  const freedKB = deleted.reduce((total, item) => total + item.size, 0);
  if (keys.length > 0) {
    // clean up R2 after responding; the cleanup cron sweeps anything this misses
    c.executionCtx.waitUntil(deleteObjects([...keys, ...thumbnailKeys]));
  }
  return c.json(
    { message: `${isFolder ? "Folder" : "File"} deleted`, deletedCount: deleted.length, freedKB },
    200,
  );
});

files.put("/:id", zValidator("param", deleteFileValidator), zValidator("json", updateFileValidator), async (c) => {
  const { id } = c.req.valid("param");
  const { name, parentPath } = c.req.valid("json");
  const currentUser = c.get("user");
  const files = await db
    .select()
    .from(objects)
    .where(and(eq(objects.ownerId, currentUser.id), eq(objects.id, id)));
  const file = files.at(0);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  const isFolder = !file.key;
  const newPath = joinPath(parentPath, name);

  if (isFolder && (parentPath === file.path || parentPath.startsWith(`${file.path}/`))) {
    return c.json({ error: "Cannot move a folder into itself" }, 400);
  }
  if (!(await parentFolderExists(currentUser.id, parentPath))) {
    return c.json({ error: "Destination folder not found" }, 404);
  }
  if (newPath !== file.path) {
    const existing = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), eq(objects.path, newPath)));
    if (existing.length > 0) {
      return c.json({ error: "An item with this name already exists at the destination" }, 409);
    }
  }

  const updateSelf = db
    .update(objects)
    .set({ name, path: newPath, parentPath, updatedAt: new Date() })
    .where(eq(objects.id, id));
  if (isFolder) {
    // rewrite every descendant's path prefix in the same transaction; length() is
    // evaluated in SQL so substr offsets stay correct for multi-byte characters
    await db.batch([
      updateSelf,
      db
        .update(objects)
        .set({
          path: sql`${newPath} || substr(${objects.path}, length(${file.path}) + 1)`,
          parentPath: sql`${newPath} || substr(${objects.parentPath}, length(${file.path}) + 1)`,
        })
        .where(and(eq(objects.ownerId, currentUser.id), isDescendantOf(file.path))),
    ]);
  } else {
    await updateSelf;
  }
  return c.json({ message: `${isFolder ? "Folder" : "File"} updated` }, 200);
});

files.post("/folder", zValidator("json", createFolderValidator), async (c) => {
  const currentUser = c.get("user");
  const { name, parentPath } = c.req.valid("json");
  const fullPath = joinPath(parentPath, name);
  const [existingObject, parentFolder] = await db.batch([
    db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.ownerId, currentUser.id), eq(objects.path, fullPath))),
    selectFolder(currentUser.id, parentPath),
  ]);
  if (existingObject.length > 0) {
    return c.json({ error: "Folder already exists" }, 400);
  }
  if (parentPath !== "" && parentFolder.length === 0) {
    return c.json({ error: "Parent folder not found" }, 404);
  }
  const [newFolder] = await db
    .insert(objects)
    .values({
      ownerId: currentUser.id,
      name: name,
      path: fullPath,
      parentPath: parentPath,
      contentType: "folder",
    })
    .returning();
  return c.json(newFolder, 201);
});
files.get("/:id", zValidator("param", deleteFileValidator), async (c) => {
  const { id } = c.req.valid("param");
  const currentUser = c.get("user");
  const [file] = await db.select().from(objects).where(and(eq(objects.ownerId, currentUser.id), eq(objects.id, id)));
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }
  if (!file.key) {
    return c.json({ error: "Folder does not have a file URL" }, 400);
  }
  const url = await getFileUrl(file.key);
  return c.json({ url: url });
});
files.get("/:id/thumbnail", zValidator("param", getThumbnailValidator), async (c) => {
  const { id } = c.req.valid("param");
  const currentUser = c.get("user");
  const [file] = await db.select().from(objects).where(and(eq(objects.ownerId, currentUser.id), eq(objects.key, id)));
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }
  if (!file.thumbnail) {
    return c.json({ error: "File does not have a thumbnail" }, 400);
  }
  const url = await getFileUrl(r2KeyToThumbnailKey(file.thumbnail));
  return c.redirect(url);
});
export default files;

