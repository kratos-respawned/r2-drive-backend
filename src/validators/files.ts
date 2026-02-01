import z from "zod";

export const convertBytesToKB = (bytes: number) => {
  return Math.ceil(bytes / 1024);
};

export const thumbnailValidator = z.object({
  size: z.number(),
  contentType: z.string(),
});
export const uploadUrlValidator = z.object({
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  thumbnail: thumbnailValidator.optional().nullable(),
  parentPath: z.string().optional().default(""),
});

export const createFileValidator = z.object({
  key: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().transform(convertBytesToKB),
  parentPath: z.string().optional().default(""),
  thumbnail: z.string().nullable().optional(),
});
export const getThumbnailValidator = z.object({
  id: z.string(),
});
export const deleteFileValidator = z.object({
  id: z.string().transform(Number),
});

export const updateFileValidator = z.object({
  name: z.string().max(255),
  parentPath: z.string().max(1000),
});

export const createFolderValidator = z.object({
  name: z.string(),
  parentPath: z.string(),
});

