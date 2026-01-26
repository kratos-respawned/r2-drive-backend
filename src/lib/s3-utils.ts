import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "cloudflare:workers";

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
export const getPresignedPutUrl = async (contentType: string, size: number, extension?: string) => {
  // R2 key is just a UUID (optionally with extension for easier identification in R2 console)
  const r2Key = extension ? `${crypto.randomUUID()}${extension}` : crypto.randomUUID();

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
  return { url, key: r2Key };
};

export const deleteObject = async (key: string) => {
  const command = new DeleteObjectCommand({ Bucket: env.BUCKET_NAME, Key: key });
  const result = await S3.send(command);
  if (result.DeleteMarker) {
    throw new Error("Failed to delete object");
  }
};
/**
 * Extract file extension from filename
 */
export const getExtension = (filename: string): string | undefined => {
  const lastDot = filename.lastIndexOf(".");
  return lastDot !== -1 ? filename.slice(lastDot) : undefined;
};
