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

```powershell
npm install
npm run build
```

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

## Privacy

WizTree CSV exports contain full local file and folder paths. This server writes exports to `exports/` by default, and that directory is intentionally ignored by Git.

Before sharing logs, screenshots, or CSV files, check that they do not expose private project names, user names, or file paths.

## Notes

- This server is read-only. It does not delete, move, or modify scanned files.
- Running WizTree with `admin: true` may trigger Windows elevation.
- The CSV parser supports both English and Japanese WizTree column headers.
