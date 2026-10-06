import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, chmod, utimes, rm, readdir, truncate, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDirectory, saveNativeSnapshot } from "../dist/native-scan.js";
import { readCsv, drillDown, oldLargeFiles, summarizeEntries } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "wiztree-fixture-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "scan");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "old.txt"), "1234567890");
  await utimes(join(root, "old.txt"), new Date("2000-01-01"), new Date("2000-01-01"));
  await writeFile(join(root, "sub", 'comma,"quote.txt'), "abc");
  await writeFile(join(base, "outside.bin"), "outside");
  await symlink(base, join(root, "external"));
  await symlink(root, join(root, "cycle"));
  await link(join(root, "old.txt"), join(root, "hard.txt"));
  return { base, root };
}

test("metadata totals, symlink boundaries, hardlinks, CSV roundtrip and POSIX case", async t => {
  const { base, root } = await fixture(t);
  await writeFile(join(root, "trailing space.txt "), "space");
  await writeFile(join(root, "A.txt"), "a");
  await writeFile(join(root, "a.txt"), "b"); // Case-insensitive host may overwrite; drilldown is tested separately below.
  const scan = await scanDirectory(root);
  assert.equal(scan.skippedSymlinks, 2);
  assert.equal(scan.hardlinkEntries, 2);
  assert.equal(scan.entries.some(e => e.path.includes("outside.bin")), false);
  const summary = summarizeEntries(scan.entries);
  assert.equal(summary.largestFolder.size, summary.totalFileSize);
  assert.equal(scan.entries.find(e => e.path === join(root, "sub") + "/").size, 3);
  const saved = await saveNativeSnapshot(scan.entries, join(base, "exports"), "baseline.csv");
  const roundtrip = await readCsv(saved.csvPath);
  assert.deepEqual(summarizeEntries(roundtrip), summary);
  assert.deepEqual(roundtrip.map(e => e.path), scan.entries.map(e => e.path));
  assert.equal((await scanDirectory(root, { maxEntries: scan.entries.length })).entries.length, scan.entries.length);
  assert.equal(oldLargeFiles(roundtrip, 365, 5, 10).length, 2);
  assert.equal(drillDown(roundtrip, root, 100).children.some(e => e.path.includes('comma,"')), false);
  const entries = ["/fixture/A/", "/fixture/A/x", "/fixture/a/", "/fixture/a/y"].map(path => ({ path, size: 1, allocated: 1, isFolder: path.endsWith("/") }));
  assert.deepEqual(drillDown(entries, "/fixture/A", 10).children.map(e => e.path), ["/fixture/A/x"]);
});

test("cancel, limits, root and symlink targets reject without saving", async t => {
  const { base, root } = await fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(scanDirectory(root, { signal: abort.signal }), /abort/i);
  const running = new AbortController();
  const pending = scanDirectory(root, { signal: running.signal });
  setImmediate(() => running.abort());
  await assert.rejects(pending, /abort/i);
  await assert.rejects(scanDirectory(root, { maxEntries: 1 }), /limit/);
  await assert.rejects(scanDirectory(root, { timeoutSeconds: 0 }), /timed out/);
  await assert.rejects(scanDirectory("/"), /Whole-disk/);
  await assert.rejects(scanDirectory(join(root, "cycle")), /symlink/);
  assert.equal((await readdir(base)).includes("exports"), false);
});

test("permission failure produces explicitly partial results", async t => {
  const { root } = await fixture(t);
  const denied = join(root, "denied"); await mkdir(denied);
  await writeFile(join(denied, "private.txt"), "unreadable");
  await chmod(denied, 0);
  t.after(() => chmod(denied, 0o700).catch(() => {}));
  try {
    const scan = await scanDirectory(root);
    assert.equal(scan.partial, true);
    assert.equal(scan.errors.some(e => e.code === "EACCES" && e.path === denied), true);
  } finally { await chmod(denied, 0o700); }
});

test("snapshot budget refuses growth without deleting existing exports", async t => {
  const { base } = await fixture(t);
  const dir = join(base, "exports"); await mkdir(dir);
  const placeholder = join(dir, "budget.csv"); await writeFile(placeholder, "");
  await truncate(placeholder, 128 * 1024 * 1024); // sparse fixture, negligible physical storage
  await assert.rejects(saveNativeSnapshot([], dir, "new.csv"), /budget/);
  assert.deepEqual(await readdir(dir), ["budget.csv"]);
});

test("English and Japanese Windows CSV analysis remains compatible", async t => {
  const { base } = await fixture(t);
  for (const header of ["File Name,Size,Allocated,Modified,Attributes,Files,Folders", "ファイル名,サイズ,割り当て,更新日時,属性,ファイル数,フォルダー"]) {
    const csv = join(base, header.startsWith("File") ? "en.csv" : "ja.csv");
    await writeFile(csv, 'Generated by WizTree\n' + header + '\n"C:\\Data\\",3,4096,2000/01/01,D,1,0\n"C:\\Data\\x.txt",3,4096,2000/01/01,,,' + '\n');
    const entries = await readCsv(csv);
    assert.equal(summarizeEntries(entries).totalFileSize, 3);
    assert.equal(drillDown(entries, "c:\\data", 10).children.length, 1);
    assert.equal(oldLargeFiles(entries, 365, 1, 10).length, 1);
  }
});

test("real stdio MCP scan handle serves every analysis tool and expires on next scan", { skip: process.platform !== "darwin" }, async t => {
  const { root, base } = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, WIZTREE_MCP_EXPORT_DIR: join(base, "exports") }, stderr: "pipe" });
  const client = new Client({ name: "fixture-test", version: "1" });
  await client.connect(transport); t.after(() => client.close());
  const call = (name, args) => client.callTool({ name, arguments: args });
  const first = await call("scan_path", { targetPath: root });
  assert.equal(first.isError, undefined);
  const scan = JSON.parse(first.content[0].text); assert.match(scan.csvPath, /^scan:/);
  for (const [name, args] of [
    ["analyze_csv", {}], ["top_entries", { kind: "files", by: "allocated" }],
    ["drill_down", { folderPath: root }], ["extension_summary", {}],
    ["old_large_files", { minSizeBytes: 5 }], ["search_entries", { query: "*.txt" }],
    ["compare_csv", { beforeCsvPath: scan.csvPath, afterCsvPath: scan.csvPath }],
  ]) {
    const result = await call(name, { csvPath: scan.csvPath, ...args });
    assert.equal(result.isError, undefined, name + ": " + result.content[0].text);
    assert.ok(result.content[0].text.length > 0);
  }
  const unsupported = await call("scan_path", { targetPath: root, treemap: true });
  assert.equal(unsupported.isError, true);
  await call("scan_path", { targetPath: root });
  assert.equal((await call("analyze_csv", { csvPath: scan.csvPath })).isError, true);
  assert.equal((await readdir(base)).includes("exports"), false);
  assert.equal((await call("scan_path", { targetPath: root, saveSnapshot: true })).isError, true);
  assert.equal((await readdir(base)).includes("exports"), false);
  const saved = JSON.parse((await call("scan_path", { targetPath: root, saveSnapshot: true, snapshotDirectory: join(base, "exports"), snapshotName: "baseline.csv" })).content[0].text);
  assert.ok(saved.snapshotBytes < 4096);
  assert.equal(saved.csvPath, join(base, "exports", "baseline.csv"));
  assert.deepEqual(await readdir(join(base, "exports")), ["baseline.csv"]);
  assert.equal((await call("analyze_csv", { csvPath: saved.csvPath })).isError, undefined);
});


test("cleanup disabled is absent from tools/list and cannot be called; default remains available", async t => {
  const { base } = await fixture(t);
  const exportsDir = join(base, "cleanup-exports");
  await mkdir(exportsDir);
  const sentinel = join(exportsDir, "keep.csv");
  await writeFile(sentinel, "keep me");
  for (const mode of ["1", "0"]) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["dist/index.js"], env: { ...process.env,
        WIZTREE_MCP_EXPORT_DIR: exportsDir, WIZTREE_MCP_DISABLE_CLEANUP: mode }, stderr: "pipe" });
    const client = new Client({ name: "cleanup-mode-test", version: "1" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      assert.equal(tools.includes("cleanup_snapshots"), mode !== "1");
      assert.equal(tools.includes("scan_path"), true);
      if (mode === "1") {
        const result = await client.callTool({ name: "cleanup_snapshots", arguments: { keepLatest: 0 } });
        assert.equal(result.isError, true);
        assert.deepEqual(await readdir(exportsDir), ["keep.csv"]);
      }
    } finally { await client.close(); }
  }
});
