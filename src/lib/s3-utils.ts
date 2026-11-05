import { GetObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "cloudflare:workers";
import z from "zod";
import { thumbnailValidator } from "../validators/files";

const S3 = new S3Client({
  region: "auto",
  // the default bakes an empty-body checksum into presigned URLs
  requestChecksumCalculation: "WHEN_REQUIRED",
  endpoint: `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_ID_KEY,
    secretAccessKey: env.R2_SECRET,
  },
});

export const getFileUrl = async (key: string) => {
  return await getSignedUrl(S3, new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: key }), {
    expiresIn: 3600,
  });
};

/**
 * Generate presigned URL for uploading a file to R2
 * @param contentType - MIME type of the file
 * @param size - File size in bytes
 * @param extension - Optional file extension (e.g., ".jpg") for easier debugging in R2 console
 * @returns Presigned URL and unique R2 key
 */
const getPresignedThumbnailUrl = (key: string, thumbnail: z.infer<typeof thumbnailValidator>) =>
  getSignedUrl(
    S3,
    new PutObjectCommand({
      Bucket: env.BUCKET_NAME,
      Key: r2KeyToThumbnailKey(key),
      ContentType: thumbnail.contentType,
      ContentLength: thumbnail.size,
    }),
    { expiresIn: 3600 },
  );

interface GetPresignedPutUrlParams {
  contentType: string;
  size: number;
  thumbnail?: z.infer<typeof thumbnailValidator> | null;
}
export const getPresignedPutUrl = async ({ contentType, size, thumbnail }: GetPresignedPutUrlParams) => {
  // R2 key is just a UUID (optionally with extension for easier identification in R2 console)
  const r2Key = crypto.randomUUID();

  const url = await getSignedUrl(
    S3,
    new PutObjectCommand({
      Bucket: env.BUCKET_NAME,
      Key: r2Key,
      ContentType: contentType,
      ContentLength: size,
    }),
    { expiresIn: 3600 },
  );

  const thumbnailUrl = thumbnail ? await getPresignedThumbnailUrl(r2Key, thumbnail) : null;

  return { url, key: r2Key, thumbnailUrl };
};

const PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;

export const getPartLayout = (size: number) => {
  const partSize = Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS));
  return { partSize, partCount: Math.ceil(size / partSize) };
};

interface StartMultipartUploadParams {
  contentType: string;
  thumbnail?: z.infer<typeof thumbnailValidator> | null;
}
export const startMultipartUpload = async ({ contentType, thumbnail }: StartMultipartUploadParams) => {
  const { key, uploadId } = await env.r2_drive.createMultipartUpload(crypto.randomUUID(), {
    httpMetadata: { contentType },
  });
  const thumbnailUrl = thumbnail ? await getPresignedThumbnailUrl(key, thumbnail) : null;
  return { key, uploadId, thumbnailUrl };
};

interface GetPresignedPartUrlParams {
  key: string;
  uploadId: string;
  partNumber: number;
  fileSize: number;
}
export const getPresignedPartUrl = ({ key, uploadId, partNumber, fileSize }: GetPresignedPartUrlParams) => {
  const { partSize, partCount } = getPartLayout(fileSize);
  const contentLength = partNumber < partCount ? partSize : fileSize - partSize * (partCount - 1);
  return getSignedUrl(
    S3,
    new UploadPartCommand({
      Bucket: env.BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: contentLength,
    }),
    { expiresIn: 3600 },
  );
};

export const completeMultipartUpload = (key: string, uploadId: string, parts: R2UploadedPart[]) =>
  env.r2_drive.resumeMultipartUpload(key, uploadId).complete(parts);

export const abortMultipartUpload = (key: string, uploadId: string) =>
  env.r2_drive.resumeMultipartUpload(key, uploadId).abort();

// deletes and listing use the native R2 binding: the S3 XML APIs cannot be
// parsed in workerd (the AWS SDK resolves a DOMParser-based XML parser there)
export const deleteObjects = async (keys: string[]) => {
  // the binding accepts at most 1000 keys per call
  for (let i = 0; i < keys.length; i += 1000) {
    await env.r2_drive.delete(keys.slice(i, i + 1000));
  }
};

export const listObjectKeys = async (cursor?: string) => {
  const result = await env.r2_drive.list({ cursor });
  return {
    keys: result.objects.map((object) => object.key),
    cursor: result.truncated ? result.cursor : undefined,
  };
};

export const THUMBNAIL_PREFIX = "thumb/";

export const r2KeyToThumbnailKey = (key: string) => {
  return `${THUMBNAIL_PREFIX}${key}`;
};