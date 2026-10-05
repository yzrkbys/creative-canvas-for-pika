---
description: Creative Canvas for Pika API Club を最新版に更新して再起動する
---
このリポジトリ（Creative Canvas for Pika API Club）を最新版に更新し、インストール済みのパッケージ版アプリを入れ替えて再起動してください。
OS を最初に判定し、手順1〜2b は共通、手順3〜6 は macOS なら下の「手順（macOS）」、Windows なら「手順（Windows）」に従う。

## 手順（macOS）

1. **最新を取得**: このフォルダが git リポジトリの場合のみ実行する（`git rev-parse --git-dir` で判定）。
   未コミットの変更があれば `git stash push -m "auto-stash for /update"`（内容を一言説明）→ `git pull --ff-only`
   （fast-forward できない／競合する場合は内容を説明してどう進めるか確認）→ 退避していれば `git stash pop` で復元する。
   git 管理下でなければこの手順は飛ばす。
2. **依存更新**: `npm install` を実行（依存が増減している場合に備える）。
2b. **モデルカタログ同期**: `npm run sync:catalog` を実行し、`server/src/pika-catalog.json` を Pika の
   最新カタログで再生成する。差分（増減したモデル数）を一言報告する。同期が「ポート割り当てが無いメディア
   フィールド」で失敗したら、**そこで止めて内容を報告する**（勝手に対応表を編集しない）。
3. **起動中アプリを停止**: 動いている Creative Canvas for Pika API Club を終了する。
   - `/Applications/Creative Canvas for Pika API Club.app` のプロセスを停止する。
   - 過去に開発モード（`npm run app` / `electron .`）で立ち上げた Electron が残っていれば停止する。
   - ポート 8797 が解放されたことを確認する（`lsof -nP -iTCP:8797 -sTCP:LISTEN` が空）。
4. **パッケージ版を再ビルド**: `npm -w desktop run dist:dir` を実行する（electron-builder。数分かかる）。出力は `desktop/release/mac-arm64/Creative Canvas for Pika API Club.app`。
5. **インストール先を入れ替え**: `rm -rf "/Applications/Creative Canvas for Pika API Club.app"` → `ditto "desktop/release/mac-arm64/Creative Canvas for Pika API Club.app" "/Applications/Creative Canvas for Pika API Club.app"`。
6. **起動して確認**: `open "/Applications/Creative Canvas for Pika API Club.app"` → 数秒待って `~/Library/Application Support/Creative Canvas for Pika API Club/server-port` に書かれたポートに対し `/api/health`（`{"ok":true}`）と `/api/models`（Pika カタログのモデルが並ぶこと）で稼働を確認する。

## 手順（Windows）

手順1〜2b は macOS と同じ（PowerShell で実行する）。

3. **起動中アプリを停止**: `Stop-Process -Name "Creative Canvas for Pika API Club" -ErrorAction SilentlyContinue` で終了し、開発モードの Electron が残っていれば `Stop-Process -Name electron -ErrorAction SilentlyContinue` で止める。ポート 8797 が空いたことを `Get-NetTCPConnection -LocalPort 8797 -State Listen -ErrorAction SilentlyContinue` が何も返さないことで確認する。
4. **インストーラを再ビルド**: `npm -w desktop run dist:win`（数分かかる）。出力は `desktop/release/CreativeCanvasForPika-Setup-<version>.exe`。
5. **インストール**: できたインストーラを実行する（`Start-Process -Wait "desktop\release\CreativeCanvasForPika-Setup-<version>.exe" -ArgumentList "/S"` でサイレント上書きインストール）。ユーザー単位のインストールなので管理者権限は要らない。既定のインストール先は `%LOCALAPPDATA%\Programs\Creative Canvas for Pika API Club\`。
6. **起動して確認**: スタートメニューかデスクトップのショートカットから起動する（またはインストール先の `Creative Canvas for Pika API Club.exe`）。数秒待って `%APPDATA%\Creative Canvas for Pika API Club\server-port` のポートに対し `Invoke-RestMethod http://127.0.0.1:<port>/api/health` と `/api/models` で稼働を確認する。

## 重要
- **`npm run app`（開発モードの `electron .`）では起動しないこと。** これは Electron 標準アイコン・アプリ名「Electron」で立ち上がり、正規パッケージ版（専用アイコン・「Creative Canvas for Pika API Club」名）とは別物になる。更新は必ず手順4〜6のパッケージ版ビルド＆入れ替えで行う。
- コード署名は未設定でよい（ローカルビルドのため `electron-builder` の署名スキップ警告は無視してよい）。Windows では未署名のため SmartScreen が出ることがある。

## 完了後に伝えること
- 作業データ（プロジェクト・生成物）と APIキーは userData 領域（macOS: `~/Library/Application Support/Creative Canvas for Pika API Club`、Windows: `%APPDATA%\Creative Canvas for Pika API Club`）に保存されるため、更新では消えない／再設定不要であること。
