import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db";
import { objects, uploadRequests } from "../db/file-schema";
import { chunked } from "./chunk";
import {
  abortMultipartUpload,
  deleteObjects,
  listObjectKeys,
  r2KeyToThumbnailKey,
  THUMBNAIL_PREFIX,
} from "./s3-utils";

// presigned upload URLs expire after 1 hour, so pending requests older than that are dead
const UPLOAD_REQUEST_TTL_MS = 60 * 60 * 1000;
// a working client asks for part URLs every few minutes, so this much silence means it left
const MULTIPART_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
// one bound parameter per key in the IN lists below
const CHUNK_SIZE = 90;

/**
 * Statement marking stale pending upload requests as expired. The presign routes
 * prepend it to their existing db.batch so an interrupted sync can never lock an
 * account out of its own quota until the next cron run (no extra round trip).
 */
export const expireStalePendingUploadsQuery = () => {
  const cutoff = new Date(Date.now() - UPLOAD_REQUEST_TTL_MS);
  return db
    .update(uploadRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(uploadRequests.status, "pending"),
        isNull(uploadRequests.uploadId),
        lt(uploadRequests.createdAt, cutoff),
      ),
    );
};

/** Expire stale pending upload requests and delete whatever they uploaded to R2. */
export const expireStaleUploadRequests = async () => {
  const expired = await expireStalePendingUploadsQuery().returning({ key: uploadRequests.key });
  // deleting keys that were never uploaded is a no-op, so this is safe for both cases
  await deleteObjects(expired.flatMap(({ key }) => [key, r2KeyToThumbnailKey(key)]));
  return expired.length;
};

/** Free the parts of multipart uploads the client walked away from. */
export const expireAbandonedMultipartUploads = async () => {
  const cutoff = new Date(Date.now() - MULTIPART_IDLE_TTL_MS);
  const abandoned = await db
    .update(uploadRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(uploadRequests.status, "pending"),
        isNotNull(uploadRequests.uploadId),
        lt(uploadRequests.lastActivityAt, cutoff),
      ),
    )
    .returning({ key: uploadRequests.key, uploadId: uploadRequests.uploadId });
  // a failed abort is not retried here: the bucket's 7-day lifecycle rule catches it
  await Promise.allSettled(abandoned.map(({ key, uploadId }) => abortMultipartUpload(key, uploadId as string)));
  await deleteObjects(abandoned.flatMap(({ key }) => [key, r2KeyToThumbnailKey(key)]));
  return abandoned.length;
};

/**
 * Delete R2 objects that nothing in the database references.
 * Orphans appear when a delete's R2 cleanup fails after its DB rows are gone,
 * or when an upload is confirmed for a request that later expired.
 */
export const sweepOrphanedObjects = async () => {
  let deletedCount = 0;
  let cursor: string | undefined;
  do {
    const page = await listObjectKeys(cursor);
    cursor = page.cursor;
    const baseKeys = page.keys.filter((key) => !key.startsWith(THUMBNAIL_PREFIX));
    const thumbnailBaseKeys = page.keys
      .filter((key) => key.startsWith(THUMBNAIL_PREFIX))
      .map((key) => key.slice(THUMBNAIL_PREFIX.length));

    const referenced = new Set<string>();
    for (const chunk of chunked([...new Set([...baseKeys, ...thumbnailBaseKeys])], CHUNK_SIZE)) {
      const [objectRows, thumbnailRows, pendingRows] = await db.batch([
        db.select({ key: objects.key }).from(objects).where(inArray(objects.key, chunk)),
        db.select({ key: objects.thumbnail }).from(objects).where(inArray(objects.thumbnail, chunk)),
        db
          .select({ key: uploadRequests.key })
          .from(uploadRequests)
          .where(and(inArray(uploadRequests.key, chunk), eq(uploadRequests.status, "pending"))),
      ]);
      for (const row of [...objectRows, ...thumbnailRows, ...pendingRows]) {
        if (row.key) referenced.add(row.key);
      }
    }

    const orphans = [
      ...baseKeys.filter((key) => !referenced.has(key)),
      ...thumbnailBaseKeys.filter((key) => !referenced.has(key)).map(r2KeyToThumbnailKey),
    ];
    await deleteObjects(orphans);
    deletedCount += orphans.length;
  } while (cursor);
  return deletedCount;
};

export const runStorageCleanup = async () => {
  const expiredCount = await expireStaleUploadRequests();
  const abandonedCount = await expireAbandonedMultipartUploads();
  const orphanCount = await sweepOrphanedObjects();
  console.log(
    `storage cleanup: expired ${expiredCount} upload requests, aborted ${abandonedCount} multipart uploads, deleted ${orphanCount} orphaned R2 objects`,
  );
};
