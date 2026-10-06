# WizTree MCP

[日本語](./README.ja.md) | [English](./README.md)

Disk-usage analysis over MCP. Windows uses WizTree CSV export; macOS uses a
read-only native metadata scanner. Existing English/Japanese WizTree CSVs remain
usable on both platforms. Scanned files are never modified.

## Snapshot lifecycle — behavior change

**Normal scans no longer create persistent snapshots on either platform.**
`scan_path` returns `csvPath: "scan:<id>"`, an in-memory handle accepted by all
CSV analysis tools. One scan is retained per process; the next successful scan
replaces it, and a restart expires it. A failed scan leaves the previous handle
available. Parsed user CSVs are cached separately (up to three).

On Windows, WizTree must export CSV. The server creates a unique temporary
directory, waits for the exporter to exit, parses its CSV, reads any treemap PNG,
and removes that temporary directory in `finally`, including exporter/parse
failure, cancellation and timeout. Only the directory created by this operation
is removed. Existing user CSVs and legacy `exports/` are not automatically
cleaned. Cleanup errors surface as failed calls. A hard process crash or power
loss can prevent `finally` from running; no broad startup sweep deletes files.

On macOS, normal scanning writes no CSV at all. There are no generated timestamp
or UUID filenames for persistent exports on either platform.

To intentionally retain a result (for example, the earlier side of a comparison),
provide **all three** parameters:

```json
{
  "targetPath": "/Users/you/Documents/example",
  "saveSnapshot": true,
  "snapshotDirectory": "/Users/you/Documents/chosen-snapshots",
  "snapshotName": "baseline.csv"
}
```

Use an absolute directory appropriate to the host; Windows accepts a path such
as `D:\chosen-snapshots`. The filename must end in `.csv` and contain only
letters, digits, dot, underscore or hyphen, with no path components. Existing
files are never overwritten. A repeated `baseline.csv` request fails with
`EEXIST` instead of silently creating another filename. Choose a new name only
when you deliberately want another snapshot. Without `saveSnapshot: true`,
providing a save destination is rejected.

Saved CSVs are limited to 32 MiB each; the direct regular files in the chosen
directory plus the new CSV must fit 128 MiB. Saves are serialized within one
server process. Avoid multiple server processes writing to the same directory.
Files created by the save operation use mode 0600 where supported. Cancelled or
failed writes remove only the new file opened by that operation. Windows saves
preserve the original WizTree CSV; Mac saves use compatible English headers.

**Compatibility changes:** previous Windows `scan_path` calls returned a
persistent timestamped CSV/PNG under `exports/`. They now return a memory handle
unless explicit saving is requested. Treemap images are returned inline and their
temporary PNGs are removed; no new persistent `treemapPath` is returned.
Previously introduced Mac `saveSnapshot: true` without a directory/name is also
rejected. Update clients that require durable filenames. Analysis output tables
now show both logical and allocated size. Standalone CSV parsing is capped at
200,000 entries; scan parsing/traversal uses `maxEntries` (default 100,000,
maximum 200,000).

## Tools

- `locate_wiztree`: Find WizTree from `WIZTREE_PATH`, `PATH`, and common locations.
- `scan_path`: Scan a specified target; return a memory handle or an explicitly named CSV. Windows supports its existing include/exclude filters, sorting, admin and treemap arguments.
- `analyze_csv`: Summarize a handle or an existing CSV.
- `top_entries`: Largest files/folders by logical or allocated size.
- `drill_down`: Direct children of a folder, sorted by size.
- `search_entries`: Path substring or glob search with matched count and size.
- `old_large_files`: Files larger than a threshold and older than a chosen age.
- `extension_summary`: File usage by extension.
- `compare_csv`: Growth/shrinkage between handles or CSV files.
- `list_snapshots`: List the configured legacy export directory. Intentionally saved snapshots elsewhere are accessed by their returned paths.
- `get_treemap`: Read a previously existing PNG from an explicit path.
- `cleanup_snapshots`: Legacy explicit deletion of older CSV/PNG files in the configured export directory. This tool does not establish ownership of legacy files; it is disabled in the configuration examples below.

Setting `WIZTREE_MCP_DISABLE_CLEANUP=1` omits `cleanup_snapshots` from
`tools/list` and rejects direct calls. Unset or other values preserve the legacy
tool's availability. It is independent of cleanup of owned Windows temporary
files, which always runs. No scan automatically removes user snapshots.
`WIZTREE_MCP_EXPORT_DIR` controls only the legacy list/cleanup directory
(default `exports/` under the repository), not the explicit save destination.

List-style tools return compact tab-separated tables. `csvPath` inputs can be
`scan:<id>` handles or filesystem paths. Save at least the earlier scan before
running a second scan if you need a comparison.

## Setup

Requires Node.js 22 or newer. Install without lifecycle scripts, then build:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Run `node dist/index.js` for stdio MCP. The process waits for JSON-RPC messages.
No native dependencies or macOS WizTree installation are required.

## Proposed MCP configuration

These are examples only; local configuration has not been changed.

macOS (adjust paths to your installation):

```toml
[mcp_servers.wiztree]
command = "/opt/homebrew/bin/node"
args = ["/path/to/wiztree-mcp/dist/index.js"]
startup_timeout_sec = 120

[mcp_servers.wiztree.env]
WIZTREE_MCP_DISABLE_CLEANUP = "1"
```

Windows:

```toml
[mcp_servers.wiztree]
command = 'node'
args = ['C:\path\to\wiztree-mcp\dist\index.js']
startup_timeout_sec = 120

[mcp_servers.wiztree.env]
WIZTREE_PATH = 'C:\Program Files\WizTree\WizTree64.exe'
WIZTREE_MCP_DISABLE_CLEANUP = '1'
```

`WIZTREE_PATH` is optional when WizTree is found in a common location or `PATH`.
`admin: true` still triggers Windows UAC. The exporter process is terminated on
cancellation/timeout and awaited before temporary-file cleanup. Windows process
termination, UAC and file-lock behavior require real Windows validation.

**No allowed-root setting is implemented.** The server can scan any directory
readable by its process. Mac rejects `/` and symlink targets, but that is not an
allowlist. CSV analysis and PNG reading also accept arbitrary readable paths;
explicit saves can target arbitrary writable directories. Register only after
agreeing on that scope or implementing the desired allowed-root policy.

## macOS backend

Only metadata is read, never file contents. `includeFiles` / `includeFolders`
control returned rows; directory totals still include all encountered regular
files. POSIX drilldown/comparison paths preserve case.

- Symlinks and nested mounts are skipped. Symlink target directories and `/` are rejected. Canonical containment is rechecked before listing. Node path APIs leave a check/list race against concurrent adversarial path replacement; scan a stable trusted directory.
- Permission and disappearing-file errors produce `partial: true`, `errorCount` and up to 100 error details. Skipped link/mount counts are separate.
- Cancellation, timeout (default 300 seconds), traversal queue and entry limits abort without publishing a result. Pending filesystem calls finish before cancellation is observed.
- Logical size is `st_size`; allocated size is `st_blocks * 512`. Hardlinks count once per path and are reported as `hardlinkEntries`. APFS clones/shared extents, compression, snapshots, purgeable storage and actual reclaimable bytes are not reconciled. Totals exclude directory metadata and special files.
- WizTree-specific admin, filters, sorting, executable path and treemap options are rejected on Mac. Use the analysis tools to filter and sort results.

## Privacy

Results and saved CSVs include full local paths. Check outputs before sharing.
Explicitly saved files outside the repository are not covered by its Git ignore
rules. Normal scans create no persistent CSV/PNG exports.

## Implementation / validation
Added native scanning, Windows temporary-export lifecycle, shared named snapshot
saves, in-memory handles, optional cleanup-tool disablement and fixture tests.
Dependencies remain unchanged; no native packages were added.

`npm run typecheck`, `npm run build`, `npm test` (16 tests) and `git diff --check` pass.
Tests cover native sizes, symlinks, hardlinks, permission errors, cancellation and
limits; English/Japanese Windows CSV compatibility; Mac real stdio analysis;
cleanup-disabled `tools/list`; explicit saves, duplicate refusal and size budgets;
and Windows mock/Node fixture subprocess export success, failure, parser failure,
cancellation and timeout, including owned-temp cleanup and user-CSV preservation.
The Windows lifecycle tests run on Mac. No real Windows/WizTree/UAC/taskkill run
was performed. Tests use small temporary fixtures
removed after execution (the 128 MiB budget fixture is sparse).

Validation used only fixtures; no real disk scan, user-data deletion, MCP
registration or persistent permission expansion was performed.

## License

MIT. See [LICENSE](./LICENSE).
