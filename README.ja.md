# WizTree MCP

[日本語](./README.ja.md) | [English](./README.md)

WizTree のCSVエクスポートを使って、ディスク使用量をMCPクライアントから読み取れるようにする読み取り専用MCPサーバーです。

> 実質Windows専用です。WizTree本体に依存します。

## できること

- `locate_wiztree`: `WIZTREE_PATH`、`PATH`、一般的なインストール先からWizTree実行ファイルを探します。
- `scan_path`: ドライブまたはフォルダをWizTreeでスキャンし、CSVスナップショットを `exports/` に保存します。`treemap: true` を指定すると、treemap PNGも出力し、画像としてそのまま返します。
- `list_snapshots`: エクスポートディレクトリ内のCSVスナップショットを新しい順に一覧します。
- `analyze_csv`: 既存のWizTree CSVを読み、容量サマリと大きいファイル/フォルダを返します。
- `top_entries`: CSV内のファイル/フォルダをサイズ順に並べます。
- `drill_down`: スナップショット内の指定フォルダ直下の子(ファイル・フォルダ)をサイズ順に返します。
- `search_entries`: 部分一致またはglob(`*` と `?`)でパスを検索し、マッチ全体の合計サイズと件数も返します。
- `old_large_files`: 長期間更新されていない大きいファイルをサイズ順に抽出します。
- `extension_summary`: 拡張子別に容量を集計します。
- `compare_csv`: 2つのCSVスナップショットを比較し、増減したパスを返します。
- `get_treemap`: 生成済みのtreemap PNGを画像として返します。
- `cleanup_snapshots`: エクスポートディレクトリ内の古いCSV/PNGを削除し、新しいものだけを残します。

このサーバーはスキャン対象のファイルには一切触れません。WizTreeをCSV出力用に起動し、生成されたCSVを読むだけです。唯一の例外は `cleanup_snapshots` で、これはエクスポートディレクトリ内にある自身のエクスポートだけを削除します。

一覧系のツールは、トークン消費を抑えるためJSONではなくタブ区切りのコンパクトなテーブルを返します。パース済みのスナップショットはメモリにキャッシュされるため、同じCSVへの繰り返しクエリで再パースは発生しません。

## セットアップ

リポジトリをcloneして、そのフォルダ内で依存関係をインストールし、TypeScriptをビルドします。

```powershell
git clone https://github.com/onmokoworks/wiztree-mcp.git
cd wiztree-mcp
npm install
npm run build
```

ビルド後に生成される `dist/index.js` が、MCPクライアントから起動するファイルです。

## MCP設定例

`C:\\path\\to\\wiztree-mcp` は、このリポジトリをcloneしたフォルダに置き換えてください。

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

`WIZTREE_PATH` は、WizTreeが一般的な場所にインストールされているか、`PATH` から見つかる場合は省略できます。

Codexで使う場合は、`C:\\Users\\<you>\\.codex\\config.toml` に次のように追加します。

```toml
[mcp_servers.wiztree]
command = 'node'
args = ['C:\path\to\wiztree-mcp\dist\index.js']
startup_timeout_sec = 120

[mcp_servers.wiztree.env]
WIZTREE_PATH = 'C:\Program Files\WizTree\WizTree64.exe'
```

MCP設定を変更した後は、クライアントの再起動または新しいセッションの開始が必要です。

## 動作確認

```powershell
node .\dist\index.js
```

このコマンドはMCPのJSON-RPCメッセージをstdioで待ち受けるため、何も表示されず待機しているように見えます。終了するには `Ctrl+C` を押してください。

## プライバシー

WizTreeのCSVには、ローカルのファイル/フォルダのフルパスが含まれます。このサーバーはデフォルトで `exports/` にCSVを書き出し、そのディレクトリはGit管理から除外しています。

ログ、スクリーンショット、CSVを共有する前に、ユーザー名、プロジェクト名、ローカルパスなどが含まれていないか確認してください。

## メモ

- スキャン対象のファイルの削除・移動・変更は行いません。ファイルを削除するのは `cleanup_snapshots` のみで、対象はエクスポートディレクトリ内に限定されます。
- `admin: true` で実行すると、WindowsのUAC昇格ダイアログが表示されます。無人環境ではタイムアウトまで処理が止まる点に注意してください。
- WizTreeの英語CSVヘッダーと日本語CSVヘッダーの両方に対応しています。

## License

MIT License. See [LICENSE](LICENSE).
