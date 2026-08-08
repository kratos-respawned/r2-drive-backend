import z from "zod";

export const convertBytesToKB = (bytes: number) => {
  return Math.ceil(bytes / 1024);
};

// "/" would corrupt the path tree, since paths are built as "<parentPath>/<name>"
export const fileNameValidator = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(255)
  .refine((name) => !name.includes("/"), "Name cannot contain '/'");

// folder names may arrive with a trailing slash (e.g. "Vacation 2024/"); strip it,
// then apply the same rules as file names — case, spaces, and unicode are preserved
// so mirrored library paths match the client's relPaths byte-for-byte
export const folderNameValidator = z
  .string()
  .trim()
  .transform((name) => name.replace(/\/+$/, ""))
  .pipe(fileNameValidator);

export const parentPathValidator = z
  .string()
  .max(1000)
  .transform((path) => path.replace(/\/+$/, ""))
  .refine((path) => !path.startsWith("/"), "parentPath cannot start with '/'");

export const thumbnailValidator = z.object({
  size: z.number(),
  contentType: z.string(),
});
export const uploadUrlValidator = z.object({
  name: fileNameValidator,
  contentType: z.string(),
  size: z.number(),
  thumbnail: thumbnailValidator.optional().nullable(),
  parentPath: parentPathValidator.optional().default(""),
});

export const createFileValidator = z.object({
  key: z.string(),
  name: fileNameValidator,
  contentType: z.string(),
  size: z.number().transform(convertBytesToKB),
  parentPath: parentPathValidator.optional().default(""),
  thumbnail: z.string().nullable().optional(),
});
// bulk-sync variants: one request replaces up to 100 presign/commit round trips
export const uploadUrlsValidator = z.object({
  items: z.array(uploadUrlValidator).min(1).max(100),
});
export const batchCommitValidator = z.object({
  items: z.array(createFileValidator).min(1).max(100),
});

export const getThumbnailValidator = z.object({
  id: z.string(),
});
export const deleteFileValidator = z.object({
  id: z.string().transform(Number),
});

export const updateFileValidator = z.object({
  name: fileNameValidator,
  parentPath: parentPathValidator,
});

export const createFolderValidator = z.object({
  name: folderNameValidator,
  parentPath: parentPathValidator,
});
