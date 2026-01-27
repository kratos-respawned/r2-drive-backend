import { sql } from "drizzle-orm";
import { index, sqliteTable, unique } from "drizzle-orm/sqlite-core";

export const objects = sqliteTable(
  "objects",
  (t) => ({
    id: t.integer().primaryKey(),
    ownerId: t.text("owner_id").notNull(),
    name: t.text("name").notNull(),
    path: t.text("path").notNull(),
    parentPath: t.text("parent_path").notNull().default(""), // "" for root level
    key: t.text("key"), // null for folders (they don't exist in R2)
    thumbnail: t.text("thumbnail"),
    contentType: t.text("content_type").notNull(), // "folder" for folders, actual mimetype for files
    size: t.integer("size").notNull().default(0),
    createdAt: t
      .integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: t
      .integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  }),
  (table) => [
    index("objects_owner_id_idx").on(table.ownerId),
    index("objects_parent_path_idx").on(table.parentPath),
    index("objects_owner_id_parent_path_idx").on(table.ownerId, table.parentPath),
    unique("objects_owner_id_path_unique").on(table.ownerId, table.path),
  ],
);

// Track upload URL requests for debugging and auditing
export const uploadRequests = sqliteTable(
  "upload_requests",
  (t) => ({
    id: t.integer().primaryKey(),
    ownerId: t.text("owner_id").notNull(),
    key: t.text("key").notNull(), // R2 key that was generated
    fileName: t.text("file_name").notNull(), // Original filename from user
    parentPath: t.text("parent_path").notNull().default(""),
    contentType: t.text("content_type").notNull(),
    size: t.integer("size").notNull(),
    status: t.text("status").notNull().default("pending"), // pending | completed | expired
    createdAt: t
      .integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    completedAt: t.integer("completed_at", { mode: "timestamp_ms" }),
  }),
  (table) => [
    index("upload_requests_owner_id_idx").on(table.ownerId),
    index("upload_requests_key_idx").on(table.key),
    index("upload_requests_status_idx").on(table.status),
  ],
);
