# WizTree MCP

Read-only MCP server that wraps WizTree's CSV export and adds disk-usage analysis tools.

> Windows-only in practice, because it depends on WizTree.

## Tools

- `locate_wiztree`: Find a WizTree executable from `WIZTREE_PATH`, `PATH`, and common install locations.
- `scan_path`: Run WizTree CSV export for a drive or folder. Writes CSV snapshots under `exports/`.
- `analyze_csv`: Summarize an existing WizTree CSV snapshot.
- `top_entries`: List the largest files or folders from a CSV snapshot.
- `extension_summary`: Aggregate file usage by extension.
- `compare_csv`: Compare two CSV snapshots and report growth/shrinkage by path.

The server never deletes files. It only launches WizTree for export and reads generated CSVs.

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

- This server is read-only. It does not delete, move, or modify scanned files.
- Running WizTree with `admin: true` may trigger Windows elevation.
- The CSV parser supports both English and Japanese WizTree column headers.
