import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "cloudflare:workers";
import z from "zod";
import { thumbnailValidator } from "../validators/files";

const S3 = new S3Client({
  region: "auto",
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

  const thumbnailUrl = thumbnail ? await getSignedUrl(
    S3,
    new PutObjectCommand({
      Bucket: env.BUCKET_NAME,
      Key: r2KeyToThumbnailKey(r2Key),
      ContentType: thumbnail.contentType,
      ContentLength: thumbnail.size,
    }),
    { expiresIn: 3600 },
  ) : null;

  return { url, key: r2Key, thumbnailUrl };
};

export const deleteObject = async (key: string) => {
  const command = new DeleteObjectCommand({ Bucket: env.BUCKET_NAME, Key: key });
  const result = await S3.send(command);
  if (result.DeleteMarker) {
    throw new Error("Failed to delete object");
  }
};


export const r2KeyToThumbnailKey = (key: string) => {
  return `thumb/${key}`;
};