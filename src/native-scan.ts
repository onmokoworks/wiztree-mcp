import { saveSnapshotBytes } from "./snapshots.js";
import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import type { WizTreeEntry } from "./index.js";

export type ScanOptions = {
  signal?: AbortSignal;
  timeoutSeconds?: number;
  maxEntries?: number;
};

// Metadata only: no file contents, symlink traversal, or elevation.
export async function scanDirectory(target: string, options: ScanOptions = {}) {
  options.signal?.throwIfAborted();
  const requested = resolve(target);
  const rootStats = await lstat(requested);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Scan target must be a directory, not a symlink or file.");
  }
  const root = await realpath(requested);
  if (root === sep) throw new Error("Whole-disk scans are disabled; choose a specific directory.");
  const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000;
  const maxEntries = options.maxEntries ?? 100_000;
  const entries: WizTreeEntry[] = [];
  const errors: { path: string; code: string }[] = [];
  let errorCount = 0;
  let skippedSymlinks = 0;
  let skippedMounts = 0;
  let hardlinkEntries = 0;
  const check = () => {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Native scan timed out; no snapshot saved.");
  };
  const addEntry = (entry: WizTreeEntry) => {
    if (entries.length >= maxEntries) throw new Error("Native scan entry limit reached; choose a smaller directory.");
    entries.push(entry);
  };
  const recordError = (path: string, error: unknown) => {
    errorCount++;
    if (errors.length < 100) errors.push({ path, code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
  };
  // Iterative postorder traversal avoids call-stack limits for deep directories.
  type Frame = { path: string; entry: WizTreeEntry; parent?: WizTreeEntry; finish: boolean };
  const folder = (path: string): WizTreeEntry => ({ path: path + sep, size: 0, allocated: 0, files: 0, folders: 0, isFolder: true });
  const stack: Frame[] = [{ path: root, entry: folder(root), finish: false }];
  while (stack.length) {
    check();
    const frame = stack.pop()!;
    if (frame.finish) {
      if (frame.parent) {
        frame.parent.size += frame.entry.size;
        frame.parent.allocated += frame.entry.allocated;
        frame.parent.files! += frame.entry.files!;
        frame.parent.folders! += 1 + frame.entry.folders!;
      }
      continue;
    }
    let stats;
    try {
      stats = await lstat(frame.path);
      if (stats.isSymbolicLink()) { skippedSymlinks++; continue; }
      if (stats.dev !== rootStats.dev) { skippedMounts++; continue; }
      // Revalidate containment before listing; do not follow links in a stable tree.
      const canonical = await realpath(frame.path);
      if (canonical !== root && !canonical.startsWith(root + sep)) {
        recordError(frame.path, Object.assign(new Error("Outside root"), { code: "OUTSIDE_ROOT" }));
        continue;
      }
      if (canonical !== frame.path) { skippedSymlinks++; continue; }
    } catch (error) { recordError(frame.path, error); continue; }
    check();
    frame.entry.modified = stats.mtime.toISOString();
    if (stats.isDirectory()) {
      addEntry(frame.entry);
      stack.push({ ...frame, finish: true });
      try {
        const directory = await readdir(frame.path, { withFileTypes: true });
        // Bound queued traversal too, including pending siblings.
        if (entries.length + stack.length + directory.length > maxEntries * 2) {
          throw new Error("Native scan queue limit reached; choose a smaller directory.");
        }
        for (const child of directory) {
          const path = join(frame.path, child.name);
          stack.push({ path, entry: folder(path), parent: frame.entry, finish: false });
        }
      } catch (error) {
        if (!(error as NodeJS.ErrnoException).code) throw error;
        recordError(frame.path, error);
      }
    } else if (stats.isFile()) {
      if (stats.nlink > 1) hardlinkEntries++;
      const entry: WizTreeEntry = { path: frame.path, size: stats.size,
        allocated: stats.blocks * 512, modified: stats.mtime.toISOString(), isFolder: false };
      addEntry(entry);
      if (frame.parent) {
        frame.parent.size += entry.size;
        frame.parent.allocated += entry.allocated;
        frame.parent.files!++;
      }
    }
  }
  options.signal?.throwIfAborted();
  return { root, entries, partial: errorCount > 0, errorCount, errors,
    skippedSymlinks, skippedMounts, hardlinkEntries,
    sizeSemantics: "Logical bytes = st_size; allocated bytes = st_blocks * 512. Hardlinks count per path. APFS clones/shared extents, compression, snapshots and purgeable storage are not reconciled; totals are not reclaimable space." };
}

export async function saveNativeSnapshot(entries: WizTreeEntry[], directory: string, name: string, signal?: AbortSignal) {
  const quote = (value: unknown) => '\"' + String(value ?? "").replaceAll('\"', '\"\"') + '\"';
  const csv = "File Name,Size,Allocated,Modified,Attributes,Files,Folders\n" + entries.map(e =>
    [e.path, e.size, e.allocated, e.modified, e.isFolder ? "D" : "", e.files, e.folders].map(quote).join(",")
  ).join("\n") + "\n";
  return saveSnapshotBytes(csv, directory, name, signal);
}
