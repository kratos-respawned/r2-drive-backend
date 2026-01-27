import z from "zod";

export const uploadUrlValidator = z.object({
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  parentPath: z.string().optional().default(""),
});

export const createFileValidator = z.object({
  key: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  parentPath: z.string().optional().default(""),
  thumbnail: z.string().nullable().optional(),
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
