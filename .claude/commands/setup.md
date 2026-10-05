---
description: Creative Canvas for Pika API Club を初回セットアップして起動する
---
あなたはこのリポジトリ（Creative Canvas for Pika API Club）のセットアップ担当です。クライアントの環境で以下を順に実行してください。各ステップは結果を確認してから次へ進むこと。macOS と Windows の両方に対応する。OS は最初に判定し（macOS: `uname`、Windows: PowerShell / `$env:OS`）、以後の手順でその OS の書き方を使う。

1. 前提確認: `node -v`（18以上か）と `git --version` を実行。Node が無い/古い場合は https://nodejs.org からの導入を案内して停止する。
   あわせて `ffmpeg -version` を確認する。無ければ macOS は `brew install ffmpeg`、Windows は `winget install Gyan.FFmpeg` を案内する（無くてもアプリは起動するが、連結・トリム・フレーム抽出・音声合成のノードが動かない）。
2. 依存導入: リポジトリ直下で `npm install` を実行（server/web/mcp/desktop 全ワークスペースが入る）。初回は数分かかる旨を伝える。
3. 起動: `npm run app` を実行。web と server をビルドしてから Electron アプリ「Creative Canvas for Pika API Club」が立ち上がる。初回ビルドは時間がかかる。
4. APIキー設定: アプリ起動後、メニュー「Canvas → 設定（APIキー）を開く」から `PIKA_API_KEY` を貼り付けて保存し（Windows ではメモ帳で開く）、「Canvas → 設定を反映して再起動」を選ぶよう案内する（キーは各自の端末のユーザーデータ領域にだけ保存され、共有されない）。
5. 使い方: 以後はこのフォルダを開いた Claude Code のチャットで「〇〇の画像を作って」等と頼めば、`creative-canvas-pika` MCP 経由でキャンバスを操作できることを伝える。MCP はこのフォルダの `.mcp.json` で自動登録済み（初回は接続許可を求められることがある）。`.mcp.json` は `node` で直接起動するので Windows でも追加設定は要らない。

注意:
- MCP はアプリ内蔵サーバ（127.0.0.1:8797）に接続するため、操作を頼む前にアプリが起動している必要がある。
- 生成・編集したデータはすべてローカル（macOS: `~/Library/Application Support/Creative Canvas for Pika API Club/`、Windows: `%APPDATA%\Creative Canvas for Pika API Club\`）に保存され、リポジトリには含まれない。
- Windows でインストーラ版を使いたい場合は `npm run app:dist:win` で `desktop/release/CreativeCanvasForPika-Setup-<version>.exe` ができる。未署名なので初回は SmartScreen の「詳細情報 → 実行」が必要な旨を伝える。
