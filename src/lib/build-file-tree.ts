// import { objects } from "../db/file-schema";

// /**
//  * Get the parent path from a full path
//  * e.g., "photos/vacation/beach.jpg" -> "photos/vacation"
//  * e.g., "readme.txt" -> ""
//  */
// export const getParentPath = (path: string): string => {
//   const parts = path.split("/").filter(Boolean);
//   if (parts.length <= 1) return "";
//   return parts.slice(0, -1).join("/");
// };

// /**
//  * Get the name (last segment) from a path
//  * e.g., "photos/vacation/beach.jpg" -> "beach.jpg"
//  * e.g., "photos/vacation" -> "vacation"
//  */
// export const getNameFromPath = (path: string): string => {
//   const parts = path.split("/").filter(Boolean);
//   return parts[parts.length - 1] || "";
// };

// /**
//  * Generate all parent folder paths that need to exist for a given file path
//  * e.g., "a/b/c/file.txt" -> ["a", "a/b", "a/b/c"]
//  */
// export const getParentFolderPaths = (filePath: string): string[] => {
//   const parts = filePath.split("/").filter(Boolean);
//   if (parts.length <= 1) return [];

//   const folders: string[] = [];
//   for (let i = 0; i < parts.length - 1; i++) {
//     folders.push(parts.slice(0, i + 1).join("/"));
//   }
//   return folders;
// };

// /**
//  * Create folder insert data for all parent folders of a file
//  * Used when uploading a file to ensure all parent folders exist in the database
//  */
// export const createFolderInserts = (
//   filePath: string,
//   ownerId: string,
// ): Array<typeof objects.$inferInsert> => {
//   const folderPaths = getParentFolderPaths(filePath);

//   return folderPaths.map((folderPath) => ({
//     ownerId,
//     name: getNameFromPath(folderPath),
//     path: folderPath,
//     parentPath: getParentPath(folderPath),
//     key: null, // folders don't exist in R2
//     thumbnail: null,
//     contentType: "folder",
//     size: 0,
//   }));
// };

// /**
//  * Create a single folder entry (for "New Folder" button)
//  */
// export const createFolderEntry = (
//   folderName: string,
//   parentPath: string,
//   ownerId: string,
// ): typeof objects.$inferInsert => {
//   const path = parentPath ? `${parentPath}/${folderName}` : folderName;
//   return {
//     ownerId,
//     name: folderName,
//     path,
//     parentPath,
//     key: null,
//     thumbnail: null,
//     contentType: "folder",
//     size: 0,
//   };
// };
