// D1 allows at most 100 bound parameters per query; callers pick a chunk size
// that keeps each statement under that limit
export const chunked = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};
