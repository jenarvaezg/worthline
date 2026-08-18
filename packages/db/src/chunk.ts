/**
 * Split a list into fixed-size chunks (#1435).
 *
 * Batched inserts are what turn an N-round-trip write into one statement, but a
 * single statement still binds one parameter per column per row, and SQLite caps
 * the parameters of one statement. Chunking keeps a long batch to a handful of
 * round-trips instead of one per row, without ever building a statement that
 * could hit the cap.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`Chunk size must be at least 1, got ${size}.`);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
