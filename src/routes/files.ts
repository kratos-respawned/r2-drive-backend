import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { user } from "../db/auth-schema";
import { objects, uploadRequests } from "../db/file-schema";
import { deleteObject, getExtension, getPresignedPutUrl } from "../lib/s3-utils";
import { authMiddleware } from "../middleware";
import { HonoEnv } from "../types";
import {
  createFileValidator,
  createFolderValidator,
  deleteFileValidator,
  updateFileValidator,
  uploadUrlValidator,
} from "../validators/files";

const files = new Hono<HonoEnv>();
files.use(authMiddleware);
files.get("/", async (c) => {
  const currentUser = c.get("user");
  const parentPath = c.req.query("path") ?? "";
  const normalizedPath = parentPath.replace(/\/$/, "");
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
    .where(and(eq(objects.ownerId, currentUser.id), eq(objects.parentPath, normalizedPath)));
  return c.json({
    currentPath: normalizedPath,
    parentPath: normalizedPath ? normalizedPath.split("/").slice(0, -1).join("/") : null,
    items,
  });
});

files.post("/upload-url", zValidator("json", uploadUrlValidator), async (c) => {
  const currentUser = c.get("user");
  const { contentType, size, name, parentPath } = c.req.valid("json");

  // Check storage quota
  const [userData] = await db
    .select({ storageAllocated: user.storageAllocated, storageUsed: user.storageUsed })
    .from(user)
    .where(eq(user.id, currentUser.id));

  if (userData.storageUsed + size > userData.storageAllocated) {
    return c.json({ error: "Storage quota exceeded" }, 400);
  }

  const normalizedParentPath = parentPath ?? "";
  const existingFile = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.ownerId, currentUser.id),
        eq(objects.name, name),
        eq(objects.parentPath, normalizedParentPath),
      ),
    );
  if (existingFile.length > 0) {
    return c.json({ error: "File already exists" }, 400);
  }
  const extension = getExtension(name);
  const { url, key } = await getPresignedPutUrl(contentType, size, extension);
  await db.insert(uploadRequests).values({
    ownerId: currentUser.id,
    key,
    fileName: name,
    parentPath: normalizedParentPath,
    contentType,
    size,
    status: "pending",
  });
  return c.json({ url, key });
});

files.post("/", zValidator("json", createFileValidator), async (c) => {
  const currentUser = c.get("user");
  const { key, name, contentType, size, parentPath, thumbnail } = c.req.valid("json");
  const normalizedParentPath = parentPath ?? "";
  const fullPath = normalizedParentPath ? `${normalizedParentPath}/${name}` : name;
  const [uploadRequest, existingFile] = await db.batch([
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
  ]);
  if (uploadRequest.length === 0) {
    return c.json({ error: "Invalid or expired upload request" }, 400);
  }
  if (existingFile.length > 0) {
    return c.json({ error: "File already exists at this path" }, 409);
  }

  // Batch insert and updates in a single round trip
  const [insertedFiles] = await db.batch([
    db
      .insert(objects)
      .values({
        ownerId: currentUser.id,
        key,
        name,
        path: fullPath,
        parentPath: normalizedParentPath,
        contentType,
        size,
        thumbnail: thumbnail ?? null,
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
  await db.delete(objects).where(eq(objects.id, id));
  // if there is no key, it is a folder, so we don't need to delete it from R2
  if (file.key) {
    await deleteObject(file.key);
    await db.delete(uploadRequests).where(eq(uploadRequests.key, file.key));
    await db
      .update(user)
      .set({ storageUsed: sql`${user.storageUsed} - ${file.size}` })
      .where(eq(user.id, currentUser.id));
  }
  return c.json({ message: `${!file.key ? "Folder" : "File"} deleted` }, 200);
});

files.put("/:id", zValidator("param", deleteFileValidator), zValidator("json", updateFileValidator), async (c) => {
  const { id } = c.req.valid("param");
  const { name, parentPath } = c.req.valid("json");
  // const normalizedName = name.replace(/\/$/, "").replace(/ /g, "_").replace(/-/g, "_").toLowerCase();
  // entPath}/${normalizedName}` : normalizedName;
  const currentUser = c.get("user");
  const files = await db
    .select()
    .from(objects)
    .where(and(eq(objects.ownerId, currentUser.id), eq(objects.id, id)));
  const file = files.at(0);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }
  await db
    .update(objects)
    .set({
      name: name.trim(),
      // will implement this later when implementing move and copy paste
      // path: parentPath,
      parentPath: parentPath,
    })
    .where(eq(objects.id, id));
  return c.json({ message: "File updated" }, 200);
});

files.post("/folder", zValidator("json", createFolderValidator), async (c) => {
  const currentUser = c.get("user");
  const { name, parentPath } = c.req.valid("json");
  const normalizedName = name.replace(/\/$/, "").replace(/ /g, "_").replace(/-/g, "_").toLowerCase();
  const fullPath = parentPath ? `${parentPath}/${normalizedName}` : normalizedName;
  const existingObject = await db.select().from(objects).where(and(eq(objects.ownerId, currentUser.id), eq(objects.path, fullPath)));
  if (existingObject.length > 0) {
    return c.json({ error: "Folder already exists" }, 400);
  }
  const newFolder = await db.insert(objects).values({
    ownerId: currentUser.id,
    name: name,
    path: fullPath,
    parentPath: parentPath,
    contentType: "folder",
  });
  return c.json(newFolder, 201);
});
export default files;
