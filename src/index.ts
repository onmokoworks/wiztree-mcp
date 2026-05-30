#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type WizTreeEntry = {
  path: string;
  size: number;
  allocated: number;
  modified?: string;
  attributes?: string;
  files?: number;
  folders?: number;
  isFolder: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const exportDir = process.env.WIZTREE_MCP_EXPORT_DIR
  ? resolve(process.env.WIZTREE_MCP_EXPORT_DIR)
  : join(projectRoot, "exports");

const server = new McpServer({
  name: "wiztree-mcp",
  version: "0.1.0",
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function parseBytes(value: unknown): number {
  if (typeof value === "number") return value;
  const cleaned = String(value ?? "").replace(/[^\d.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const signed = bytes < 0 ? "-" : "";
  const decimals = unit === 0 ? 0 : value >= 100 ? 1 : 2;
  return `${signed}${value.toFixed(decimals)} ${units[unit]}`;
}

function getField(record: Record<string, unknown>, ...names: string[]): unknown {
  const key = Object.keys(record).find((candidate) => names.includes(candidate.replace(/^\uFEFF/, "")));
  return key ? record[key] : undefined;
}

async function readCsv(csvPath: string): Promise<WizTreeEntry[]> {
  const raw = await readFile(resolve(csvPath), "utf8");
  const lines = raw.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const normalized = line.replace(/^\uFEFF/, "").toLowerCase();
    return normalized.startsWith("file name,") || normalized.startsWith("ファイル名,");
  });
  const csv = headerIndex >= 0 ? lines.slice(headerIndex).join("\n") : raw;
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, unknown>[];

  const entries: WizTreeEntry[] = [];
  for (const record of records) {
    const path = String(getField(record, "File Name", "ファイル名") ?? "").trim();
    if (!path) continue;

    const entry: WizTreeEntry = {
      path,
      size: parseBytes(getField(record, "Size", "サイズ")),
      allocated: parseBytes(getField(record, "Allocated", "割り当て")),
      isFolder: path.endsWith("\\") || path.endsWith("/"),
    };
    const modified = String(getField(record, "Modified", "更新日時") ?? "");
    const attributes = String(getField(record, "Attributes", "属性") ?? "");
    const files = parseCount(getField(record, "Files", "ファイル数"));
    const folders = parseCount(getField(record, "Folders", "フォルダー"));
    if (modified) entry.modified = modified;
    if (attributes) entry.attributes = attributes;
    if (files !== undefined) entry.files = files;
    if (folders !== undefined) entry.folders = folders;
    entries.push(entry);
  }

  return entries;
}

function summarizeEntries(entries: WizTreeEntry[]) {
  const files = entries.filter((entry) => !entry.isFolder);
  const folders = entries.filter((entry) => entry.isFolder);
  const totalFileSize = files.reduce((sum, entry) => sum + entry.size, 0);
  const totalAllocated = files.reduce((sum, entry) => sum + entry.allocated, 0);
  const largestRoot = folders.reduce<WizTreeEntry | undefined>(
    (largest, entry) => (!largest || entry.size > largest.size ? entry : largest),
    undefined,
  );

  return {
    entries: entries.length,
    fileEntries: files.length,
    folderEntries: folders.length,
    totalFileSize,
    totalFileSizeHuman: formatBytes(totalFileSize),
    totalAllocated,
    totalAllocatedHuman: formatBytes(totalAllocated),
    largestFolder: largestRoot
      ? {
          path: largestRoot.path,
          size: largestRoot.size,
          sizeHuman: formatBytes(largestRoot.size),
          files: largestRoot.files,
          folders: largestRoot.folders,
        }
      : undefined,
  };
}

function topEntries(entries: WizTreeEntry[], kind: "files" | "folders" | "all", limit: number, by: "size" | "allocated") {
  return entries
    .filter((entry) => kind === "all" || (kind === "files" ? !entry.isFolder : entry.isFolder))
    .sort((a, b) => b[by] - a[by])
    .slice(0, limit)
    .map((entry) => ({
      path: entry.path,
      kind: entry.isFolder ? "folder" : "file",
      size: entry.size,
      sizeHuman: formatBytes(entry.size),
      allocated: entry.allocated,
      allocatedHuman: formatBytes(entry.allocated),
      modified: entry.modified,
      files: entry.files,
      folders: entry.folders,
    }));
}

function extensionOf(entry: WizTreeEntry): string {
  const extension = extname(entry.path).toLowerCase();
  return extension || "[no extension]";
}

function findWizTreeCandidates(): string[] {
  const candidates = new Set<string>();
  const envPath = process.env.WIZTREE_PATH;
  if (envPath) candidates.add(envPath);

  const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const dir of pathDirs) {
    candidates.add(join(dir, "WizTree64.exe"));
    candidates.add(join(dir, "WizTree.exe"));
  }

  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[]) {
    candidates.add(join(root, "WizTree", "WizTree64.exe"));
    candidates.add(join(root, "WizTree", "WizTree.exe"));
    candidates.add(join(root, "Antibody Software", "WizTree", "WizTree64.exe"));
    candidates.add(join(root, "Antibody Software", "WizTree", "WizTree.exe"));
  }

  candidates.add(join(projectRoot, "WizTree64.exe"));
  candidates.add(join(projectRoot, "WizTree.exe"));
  candidates.add(join(dirname(projectRoot), "WizTree", "WizTree64.exe"));
  candidates.add(join(dirname(projectRoot), "WizTree", "WizTree.exe"));

  return [...candidates];
}

function locateWizTree(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  return findWizTreeCandidates().find((candidate) => existsSync(candidate));
}

function safeName(input: string): string {
  return input.replace(/^[A-Za-z]:/, (drive) => drive.replace(":", "")).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "scan";
}

async function runWizTree(args: string[], timeoutSeconds: number): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`WizTree timed out after ${timeoutSeconds} seconds.`));
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`WizTree exited with code ${code}.${stderr ? ` stderr: ${stderr}` : ""}`));
      }
    });
  });
}

server.registerTool(
  "locate_wiztree",
  {
    title: "Locate WizTree",
    description: "Find a WizTree executable using WIZTREE_PATH, PATH, and common install folders.",
    inputSchema: {},
  },
  async () => {
    const candidates = findWizTreeCandidates().map((candidate) => ({
      path: candidate,
      exists: existsSync(candidate),
    }));
    return jsonResult({
      found: candidates.find((candidate) => candidate.exists)?.path,
      candidates,
    });
  },
);

server.registerTool(
  "scan_path",
  {
    title: "Scan Path",
    description: "Run WizTree CSV export for a drive or folder. This is read-only and writes a CSV snapshot.",
    inputSchema: {
      targetPath: z.string().describe('Drive or folder to scan, such as "C:" or "D:\\Data".'),
      wiztreePath: z.string().optional().describe("Optional explicit path to WizTree64.exe or WizTree.exe."),
      includeFiles: z.boolean().default(true).describe("Include file rows in the export."),
      includeFolders: z.boolean().default(true).describe("Include folder rows in the export."),
      admin: z.boolean().default(false).describe("Pass /admin=1 to WizTree. May trigger Windows elevation."),
      filter: z.string().optional().describe('Optional WizTree include filter, such as "*.mp4".'),
      filterExclude: z.string().optional().describe('Optional WizTree exclude filter, such as "node_modules".'),
      sortBy: z.string().optional().describe('Optional WizTree sort option, such as "size".'),
      treemap: z.boolean().default(false).describe("Also export a 1024x768 treemap PNG beside the CSV."),
      timeoutSeconds: z.number().int().positive().max(3600).default(300),
    },
  },
  async (input) => {
    const wiztree = locateWizTree(input.wiztreePath);
    if (!wiztree) {
      return textResult("WizTree executable was not found. Set WIZTREE_PATH or pass wiztreePath.");
    }

    await mkdir(exportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${safeName(input.targetPath)}_${stamp}`;
    const csvPath = join(exportDir, `${base}.csv`);
    const pngPath = join(exportDir, `${base}.png`);
    const args = [
      wiztree,
      input.targetPath,
      `/export=${csvPath}`,
      `/admin=${input.admin ? 1 : 0}`,
      `/exportfiles=${input.includeFiles ? 1 : 0}`,
      `/exportfolders=${input.includeFolders ? 1 : 0}`,
    ];

    if (input.filter) args.push(`/filter=${input.filter}`);
    if (input.filterExclude) args.push(`/filterexclude=${input.filterExclude}`);
    if (input.sortBy) args.push(`/sortby=${input.sortBy}`);
    if (input.treemap) {
      args.push(`/treemapimagefile=${pngPath}`);
      args.push("/treemapimagewidth=1024");
      args.push("/treemapimageheight=768");
      args.push("/treemapimagefreespace=0");
      args.push("/treemapimageshowallocated=1");
    }

    const result = await runWizTree(args, input.timeoutSeconds);
    const entries = existsSync(csvPath) ? await readCsv(csvPath) : [];
    return jsonResult({
      wiztree,
      targetPath: input.targetPath,
      csvPath,
      treemapPath: input.treemap ? pngPath : undefined,
      summary: summarizeEntries(entries),
      stdout: result.stdout.trim() || undefined,
      stderr: result.stderr.trim() || undefined,
    });
  },
);

server.registerTool(
  "analyze_csv",
  {
    title: "Analyze CSV",
    description: "Summarize an existing WizTree CSV snapshot.",
    inputSchema: {
      csvPath: z.string().describe("Path to a WizTree CSV export."),
      topLimit: z.number().int().positive().max(100).default(20),
    },
  },
  async (input) => {
    const entries = await readCsv(input.csvPath);
    return jsonResult({
      csvPath: resolve(input.csvPath),
      summary: summarizeEntries(entries),
      largestFiles: topEntries(entries, "files", input.topLimit, "size"),
      largestFolders: topEntries(entries, "folders", input.topLimit, "size"),
    });
  },
);

server.registerTool(
  "top_entries",
  {
    title: "Top Entries",
    description: "List the largest files, folders, or all rows from a WizTree CSV snapshot.",
    inputSchema: {
      csvPath: z.string(),
      kind: z.enum(["files", "folders", "all"]).default("all"),
      by: z.enum(["size", "allocated"]).default("size"),
      limit: z.number().int().positive().max(500).default(50),
    },
  },
  async (input) => {
    const entries = await readCsv(input.csvPath);
    return jsonResult(topEntries(entries, input.kind, input.limit, input.by));
  },
);

server.registerTool(
  "extension_summary",
  {
    title: "Extension Summary",
    description: "Aggregate file usage by extension from a WizTree CSV snapshot.",
    inputSchema: {
      csvPath: z.string(),
      limit: z.number().int().positive().max(500).default(100),
    },
  },
  async (input) => {
    const entries = (await readCsv(input.csvPath)).filter((entry) => !entry.isFolder);
    const byExtension = new Map<string, { extension: string; files: number; size: number; allocated: number }>();
    for (const entry of entries) {
      const extension = extensionOf(entry);
      const current = byExtension.get(extension) ?? { extension, files: 0, size: 0, allocated: 0 };
      current.files += 1;
      current.size += entry.size;
      current.allocated += entry.allocated;
      byExtension.set(extension, current);
    }

    return jsonResult(
      [...byExtension.values()]
        .sort((a, b) => b.size - a.size)
        .slice(0, input.limit)
        .map((row) => ({
          ...row,
          sizeHuman: formatBytes(row.size),
          allocatedHuman: formatBytes(row.allocated),
        })),
    );
  },
);

server.registerTool(
  "compare_csv",
  {
    title: "Compare CSV",
    description: "Compare two WizTree CSV snapshots by path and report the largest changes.",
    inputSchema: {
      beforeCsvPath: z.string(),
      afterCsvPath: z.string(),
      kind: z.enum(["files", "folders", "all"]).default("all"),
      limit: z.number().int().positive().max(500).default(50),
    },
  },
  async (input) => {
    const before = (await readCsv(input.beforeCsvPath)).filter(
      (entry) => input.kind === "all" || (input.kind === "files" ? !entry.isFolder : entry.isFolder),
    );
    const after = (await readCsv(input.afterCsvPath)).filter(
      (entry) => input.kind === "all" || (input.kind === "files" ? !entry.isFolder : entry.isFolder),
    );
    const beforeMap = new Map(before.map((entry) => [entry.path.toLowerCase(), entry]));
    const afterMap = new Map(after.map((entry) => [entry.path.toLowerCase(), entry]));
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const changes = [...keys].map((key) => {
      const oldEntry = beforeMap.get(key);
      const newEntry = afterMap.get(key);
      const path = newEntry?.path ?? oldEntry?.path ?? key;
      const beforeSize = oldEntry?.size ?? 0;
      const afterSize = newEntry?.size ?? 0;
      const delta = afterSize - beforeSize;
      return {
        path,
        kind: (newEntry ?? oldEntry)?.isFolder ? "folder" : "file",
        beforeSize,
        beforeSizeHuman: formatBytes(beforeSize),
        afterSize,
        afterSizeHuman: formatBytes(afterSize),
        delta,
        deltaHuman: formatBytes(delta),
        status: oldEntry && newEntry ? "changed" : oldEntry ? "removed" : "added",
      };
    });

    return jsonResult({
      growth: changes.filter((change) => change.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, input.limit),
      shrinkage: changes.filter((change) => change.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, input.limit),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
