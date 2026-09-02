---
description: Creative Canvas for Pika API Club を初回セットアップして起動する
---
あなたはこのリポジトリ（Creative Canvas for Pika API Club）のセットアップ担当です。クライアントの環境で以下を順に実行してください。各ステップは結果を確認してから次へ進むこと。

1. 前提確認: `node -v`（18以上か）と `git --version` を実行。Node が無い/古い場合は https://nodejs.org からの導入を案内して停止する。
2. 依存導入: リポジトリ直下で `npm install` を実行（server/web/mcp/desktop 全ワークスペースが入る）。初回は数分かかる旨を伝える。
3. 起動: `npm run app` を実行。web と server をビルドしてから Electron アプリ「Creative Canvas for Pika API Club」が立ち上がる。初回ビルドは時間がかかる。
4. APIキー設定: アプリ起動後、メニュー「Canvas → 設定（APIキー）を開く」から `PIKA_API_KEY` を貼り付けて保存し、アプリを再起動するよう案内する（キーは各自の端末のユーザーデータ領域にだけ保存され、共有されない）。
5. 使い方: 以後はこのフォルダを開いた Claude Code のチャットで「〇〇の画像を作って」等と頼めば、`creative-canvas-pika` MCP 経由でキャンバスを操作できることを伝える。MCP はこのフォルダの `.mcp.json` で自動登録済み（初回は接続許可を求められることがある）。

注意:
- MCP はアプリ内蔵サーバ（localhost:8797）に接続するため、操作を頼む前にアプリが起動している必要がある。
- 生成・編集したデータはすべてローカル（macOS: `~/Library/Application Support/Creative Canvas for Pika API Club/`、Windows: `%APPDATA%/Creative Canvas for Pika API Club/`）に保存され、リポジトリには含まれない。
