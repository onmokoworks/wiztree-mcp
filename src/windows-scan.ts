import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSnapshotBytes, validateSnapshotDestination } from "./snapshots.js";
import type { WizTreeEntry } from "./index.js";

type ProcessResult = { stdout: string; stderr: string };
export async function runExportProcess(args: string[], timeoutSeconds: number, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(args[0], args.slice(1), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let stopReason: Error | undefined;
    const stop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      // Await child close before allowing the caller to remove its exports.
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
        killer.on("close", code => { if (code !== 0) child.kill(); });
      } else child.kill();
    };
    const onAbort = () => stop(new Error("WizTree scan cancelled."));
    const timeout = setTimeout(() => stop(new Error(`WizTree timed out after ${timeoutSeconds} seconds.`)), timeoutSeconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); };
    child.stdout?.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-128_000); });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-128_000); });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (stopReason) reject(stopReason);
      else if (code === 0) done({ stdout, stderr });
      else reject(new Error(`WizTree exited with code ${code}.${stderr ? ` stderr: ${stderr}` : ""}`));
    });
  });
}

export type WindowsScanInput = {
  targetPath: string; includeFiles: boolean; includeFolders: boolean; admin: boolean;
  filter?: string; filterExclude?: string; sortBy?: string; treemap: boolean;
  timeoutSeconds: number; maxEntries: number;
  saveSnapshot: boolean; snapshotDirectory?: string; snapshotName?: string;
};
type Dependencies = {
  parseCsv: (path: string, signal?: AbortSignal, maxEntries?: number) => Promise<WizTreeEntry[]>;
  run?: typeof runExportProcess;
  temporaryParent?: string; // fixture seam only, never exposed by MCP
};
export async function scanWindows(wiztree: string, input: WindowsScanInput, deps: Dependencies, signal?: AbortSignal) {
  if (input.saveSnapshot) validateSnapshotDestination(input.snapshotDirectory, input.snapshotName);
  signal?.throwIfAborted();
  // This uniquely created directory is the only tree removed automatically.
  const temporary = await mkdtemp(join(deps.temporaryParent ?? tmpdir(), "wiztree-mcp-"));
  const csvPath = join(temporary, "scan.csv");
  const pngPath = join(temporary, "treemap.png");
  let captured: { entries: WizTreeEntry[]; image?: { type: "image"; data: string; mimeType: string }; csv?: Buffer } & ProcessResult;
  try {
    const args = [wiztree, input.targetPath, `/export=${csvPath}`,
      `/admin=${input.admin ? 1 : 0}`, `/exportfiles=${input.includeFiles ? 1 : 0}`, `/exportfolders=${input.includeFolders ? 1 : 0}`];
    if (input.filter) args.push(`/filter=${input.filter}`);
    if (input.filterExclude) args.push(`/filterexclude=${input.filterExclude}`);
    if (input.sortBy) args.push(`/sortby=${input.sortBy}`);
    if (input.treemap) args.push(`/treemapimagefile=${pngPath}`, "/treemapimagewidth=1024", "/treemapimageheight=768", "/treemapimagefreespace=0", "/treemapimageshowallocated=1");
    const output = await (deps.run ?? runExportProcess)(args, input.timeoutSeconds, signal);
    signal?.throwIfAborted();
    const entries = await deps.parseCsv(csvPath, signal, input.maxEntries);
    signal?.throwIfAborted();
    const image = input.treemap ? { type: "image" as const, data: (await readFile(pngPath)).toString("base64"), mimeType: "image/png" } : undefined;
    let originalCsv: Buffer | undefined;
    if (input.saveSnapshot) {
      if ((await stat(csvPath)).size > 32 * 1024 * 1024) throw new Error("Snapshot exceeds 32 MiB; choose a smaller directory.");
      originalCsv = await readFile(csvPath);
    }
    captured = { entries, image, csv: originalCsv, ...output };
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  signal?.throwIfAborted();
  // Commit an intentional save only after temporary exports are removed.
  const { csv, ...result } = captured!;
  const saved = csv ? await saveSnapshotBytes(csv, input.snapshotDirectory!, input.snapshotName!, signal) : undefined;
  return { ...result, saved };
}
