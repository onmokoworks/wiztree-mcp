# WizTree MCP

[日本語](./README.ja.md) | [English](./README.md)

Read-only MCP server that wraps WizTree's CSV export and adds disk-usage analysis tools.

> Windows-only in practice, because it depends on WizTree.

## Tools

- `locate_wiztree`: Find a WizTree executable from `WIZTREE_PATH`, `PATH`, and common install locations.
- `scan_path`: Run WizTree CSV export for a drive or folder. Writes CSV snapshots under `exports/`. With `treemap: true`, also exports a treemap PNG and returns it inline as an image.
- `list_snapshots`: List CSV snapshots in the export directory, newest first.
- `analyze_csv`: Summarize an existing WizTree CSV snapshot.
- `top_entries`: List the largest files or folders from a CSV snapshot.
- `drill_down`: List the direct children of a folder within a snapshot, sorted by size.
- `search_entries`: Search a snapshot for paths matching a substring or glob (`*` and `?`), with total matched size and count.
- `old_large_files`: Find large files not modified for a long time, sorted by size.
- `extension_summary`: Aggregate file usage by extension.
- `compare_csv`: Compare two CSV snapshots and report growth/shrinkage by path.
- `get_treemap`: Return a previously generated treemap PNG as an image.
- `cleanup_snapshots`: Delete older CSV/PNG exports from the export directory, keeping the most recent ones.

The server never touches scanned files. It only launches WizTree for export and reads generated CSVs; the one exception is `cleanup_snapshots`, which deletes only this server's own exports inside the export directory.

List-style tools return compact tab-separated tables instead of JSON to keep token usage low. Parsed snapshots are cached in memory, so repeated queries against the same CSV do not re-parse it.

## Setup

Clone the repo, enter the repo folder, install dependencies, and build the TypeScript output.

```powershell
git clone https://github.com/onmokoworks/wiztree-mcp.git
cd wiztree-mcp
npm install
npm run build
```

This produces `dist/index.js`, which is the file your MCP client should run.

## MCP Config

Replace `C:\\path\\to\\wiztree-mcp` with the folder where you cloned this repo.

```json
{
  "mcpServers": {
    "wiztree": {
      "command": "node",
      "args": ["C:\\path\\to\\wiztree-mcp\\dist\\index.js"],
      "env": {
        "WIZTREE_PATH": "C:\\Program Files\\WizTree\\WizTree64.exe"
      }
    }
  }
}
```

`WIZTREE_PATH` is optional if WizTree is installed in a common location or is on `PATH`.

For Codex, add the same server to `C:\\Users\\<you>\\.codex\\config.toml`:

```toml
[mcp_servers.wiztree]
command = 'node'
args = ['C:\path\to\wiztree-mcp\dist\index.js']
startup_timeout_sec = 120

[mcp_servers.wiztree.env]
WIZTREE_PATH = 'C:\Program Files\WizTree\WizTree64.exe'
```

After changing MCP configuration, restart the MCP client or open a new session so it reloads the server list.

## Smoke Test

You can verify that the compiled server starts with:

```powershell
node .\dist\index.js
```

The process waits for MCP JSON-RPC messages over stdio, so it will appear idle. Press `Ctrl+C` to stop it.

## Privacy

WizTree CSV exports contain full local file and folder paths. This server writes exports to `exports/` by default, and that directory is intentionally ignored by Git.

Before sharing logs, screenshots, or CSV files, check that they do not expose private project names, user names, or file paths.

## Notes

- This server does not delete, move, or modify scanned files. Only `cleanup_snapshots` deletes files, and only inside the export directory.
- Running WizTree with `admin: true` triggers a Windows UAC elevation dialog; in an unattended environment the scan will hang until the configured timeout.
- The CSV parser supports both English and Japanese WizTree column headers.
