import { lstat, readdir, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export function validateSnapshotDestination(directory?: string, name?: string) {
  if (!directory || !isAbsolute(directory) || !name) {
    throw new Error("Saving requires an explicit absolute snapshotDirectory and snapshotName ending in .csv.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.csv$/i.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)) {
    throw new Error("snapshotName must be a simple CSV filename (letters, digits, dot, underscore, hyphen); no path components.");
  }
}

// Serialize saves in this process so concurrent MCP calls cannot bypass the budget.
let saveQueue: Promise<void> = Promise.resolve();
export async function saveSnapshotBytes(csv: string | Buffer, directory: string, name: string, signal?: AbortSignal) {
  validateSnapshotDestination(directory, name);
  signal?.throwIfAborted();
  const bytes = Buffer.byteLength(csv);
  if (bytes > 32 * 1024 * 1024) throw new Error("Snapshot exceeds 32 MiB; choose a smaller directory.");
  const previous = saveQueue;
  let release!: () => void;
  saveQueue = new Promise<void>(done => { release = done; });
  await previous;
  try {
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Snapshot directory must not be a symlink.");
    let existingBytes = 0;
    for (const filename of await readdir(directory)) {
      const stats = await lstat(join(directory, filename));
      if (stats.isFile()) existingBytes += stats.size;
    }
    if (existingBytes + bytes > 128 * 1024 * 1024) throw new Error("Snapshot directory exceeds 128 MiB budget; review saved snapshots before saving more.");
    const csvPath = join(directory, name);
    signal?.throwIfAborted();
    // Exclusive creation never overwrites user CSVs. Cleanup is limited to a file
    // whose handle we created successfully in this operation.
    const file = await open(csvPath, "wx", 0o600);
    try {
      await file.writeFile(csv, { signal });
      await file.close();
      signal?.throwIfAborted();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(csvPath);
      throw error;
    }
    return { csvPath, snapshotBytes: bytes, snapshotDirectoryBytes: existingBytes + bytes };
  } finally { release(); }
}
