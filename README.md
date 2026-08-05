# Pika Canvas

ノードベースのクリエイティブ・キャンバス（画像・動画・音声・テキストをノードでつなぐデスクトップアプリ）。
生成の実行はすべて **Pika API** に一本化されていて、**APIキー1本**でカタログ全モデルが使えます。
**Claude Code から操作**できる MCP サーバを内蔵し、チャットで指示するだけでキャンバスを組み立て・生成できます。

- デスクトップアプリ（Electron）＋内蔵サーバ＋ React キャンバス UI
- `pika-canvas` MCP サーバ同梱（このフォルダを Claude Code で開くと自動登録）
- 生成データはすべて**各自の端末ローカル**に保存（リポジトリでは共有されません）

Creative Canvas（KIE / fal / xAI をプロバイダごとに実装していた版）のクローンで、
**モデル層をカタログ駆動に置き換え**たものです。詳細は下の「モデルレジストリの仕組み」を参照。

---

## 必要なもの

- **Node.js 18 以上**（推奨 LTS） … https://nodejs.org
- **git**
- **Claude Code**
- **Pika の API キー** … https://dev.pika.art のダッシュボードで発行
  - 画像・動画・音声・LLM の全モデルがこのキー1本で動きます（課金は USD、**成功した生成のみ課金**）
  - 無くても `MOCK_PROVIDER=1` でプレースホルダ生成のお試しは可能
- **ffmpeg / ffprobe**（動画連結・フレーム抽出・音声合成のビルトインノード用）

対応 OS: **macOS / Windows**

---

## セットアップ

1. このフォルダを **Claude Code で開く**
2. チャットで `/setup` を実行
   → 依存インストール（`npm install`）→ ビルド＆起動（`npm run app`）まで自動で進みます。
3. アプリが起動したら、メニュー **「Canvas → 設定（APIキー）を開く」** で `PIKA_API_KEY` を貼り付けて保存 → アプリを再起動。

> 手動で進めたい場合:
> ```bash
> npm install
> npm run app
> ```

---

## ノードの種類

| グループ | ノード | 入力 → 出力 |
|---|---|---|
| 画像 | `image_gen` / `image_edit` / `image_upload` | text・画像 → 画像 |
| 動画 | `video_gen` / `video_upscale` / `video_concat` / `frame_extract` / `video_upload` | text・画像・動画・音声 → 動画 |
| 音声 | `audio_gen` / `video_to_audio` / `av_mux` / `transcribe` / `audio_upload` | text・音声・動画 → 音声（`transcribe` はテキスト） |
| テキスト | `llm_text` / `note` / `doc` / `web_clip` / `file_import` | text → text |
| レイアウト | `frame` | 視覚的なグルーピング枠 |

すべての生成ノードは **Pika の APIキー1本**で動きます（builtin の ffmpeg 系・Webクリップは無料）。
それ以外の認証・アカウントは必要ありません。

`video_gen` は t2v / i2v / first-last-frame / reference-to-video / video-to-video / extension /
motion-control / avatar を**1つのノード種別**でカバーします。どのポートが要るかはモデル側のスキーマが決めるので、
モデルを変えれば必要な配線も変わります（未接続・誤配線は**課金前に**弾かれます）。

**スコアリングの往復**が閉じているのがこの版の特徴です:
`video_gen → video_to_audio（劇伴/SEを生成）→ av_mux（映像に戻す）` がキャンバス内で完結します。

---

## 使い方

1. **Pika Canvas アプリを起動しておく**（内蔵サーバが `localhost:8797` で待ち受けます）。
2. このフォルダを開いた Claude Code のチャットで指示するだけ。例:
   - 「『夕焼けの富士山』の画像ノードを作って生成して」
   - 「この画像から5秒の動画を作って」
   - 「このカットに劇伴を付けて、映像に合成して」
   MCP（`pika-canvas`）経由でノードの追加・接続・生成が行われ、キャンバスにリアルタイム反映されます。

---

## モデルレジストリの仕組み（カタログ駆動）

Pika は全エンドポイントの **JSON Schema と価格ティア**を公開しています
（`GET /catalog/apis` と `GET /catalog/apis/{api_id}?expand=inputs`・どちらも認証不要）。
そのため、このリポジトリには**手書きのモデル定義がありません**。

```bash
npm run sync:catalog     # → server/src/pika-catalog.json を再生成
```

同期スクリプトが生成するもの:

- **パラメータUI** … enum → セレクト、整数 → 数値入力、`anyOf:[整数4-15, "auto"]` のような合成型も選択肢に展開
- **既定値** … スキーマが宣言したものだけ。宣言が無ければ「（モデル既定）」＝**フィールドを送らない**
  （勝手に先頭の選択肢を既定にすると Seedance が無言で 480p / 1:1 に固定されるため）
- **ポート結線** … スキーマの `media_kinds` 注釈から、どのフィールドが画像/動画/音声を取るかを判定
- **コスト計算** … 価格ティアの `spec` をノードのパラメータと突き合わせて単価を選択

手で保守するのは `server/src/pika-port-bindings.json` の**17個のフィールド名 → ポート対応表だけ**です。
カタログに未知のメディアフィールドが増えると同期は**失敗して停止**します（黙って入力を落として課金するより良いため）。

新モデルへの追随は「同期を再実行するだけ」で、アダプタの分岐を書く必要はありません。
アプリを再ビルドせずに反映したい場合は、生成した `pika-catalog.json` を
`~/Library/Application Support/Pika Canvas/` に置いてアプリを再起動すれば、同梱版より優先されます。

### コスト表示について

課金単位はモデルによって違い、**事前に金額を出せるものと出せないものがあります**。

| 単位 | 例 | 事前見積り |
|---|---|---|
| 秒 | Kling, Veo, HappyHorse | ○ 単価 × 尺 |
| 枚 | Seedream, GPT-Image-2 | ○ 単価 × 枚数 |
| 文字 | ElevenLabs TTS | ○ 単価 × プロンプト文字数 |
| 回 | 一部モデル | ○ 定額 |
| 分 | Sonilo スコアリング | △ 入力動画の尺に比例（実行前に計測しない） |
| トークン | Seedance, Gemini Omni, LLM | **✗ 生成量が事前に不明** |

トークン課金のモデルは金額を**捏造せず**「事前見積り不可」と表示し、確認ダイアログを出します。
`$0` は「無料」ではなく「見積り不能」の意味です。

---

## 課金前ガード

「配線が無視されたまま課金される」のを防ぐため、実行前に以下を検査して**止めます**（アップロードより前）。

- 必須のメディア入力が未接続
- そのモデルが**読まないポート**にメディアが繋がっている（例: t2i モデルに参照画像）
- 単数フィールドに複数接続 / 配列フィールドの上限超過
- プロンプトがモデルの文字数上限を超過
- 構造化パラメータ（ElevenLabs のダイアログ、Kling omni-video）が未指定

いずれもエラー文で「どのポートを外すか／どこに繋ぐか」を示します。

---

## データの保存場所（共有されません）

- macOS: `~/Library/Application Support/Pika Canvas/`
- Windows: `%APPDATA%\Pika Canvas\`

リポジトリには作業データ・`.env`（APIキー）は含まれません（`.gitignore` 済み）。

---

## ライセンス

MIT License（[LICENSE](LICENSE)）。

Pika API の利用には Pika の利用規約が適用されます。生成物の権利・課金はお使いの
Pika アカウントに紐づきます。

## 開発者向けメモ

- ブラウザ開発モード: `npm run dev`（server:8797 + web:5173）。`.env` は `.env.example` をコピーして作成。
- 型チェック: `npm run typecheck`
- 構成: `server/`（Express + WebSocket・内蔵API）/ `web/`（React + React Flow）/ `mcp/`（stdio MCP→HTTP）/ `desktop/`（Electron）
- 走行中のアプリを止めずに検証する: 別ポート＋別データディレクトリで起動する
  ```bash
  PORT=8891 PIKA_CANVAS_DATA_DIR=/tmp/pikadev node_modules/.bin/tsx server/src/index.ts
  ```
- 配布パッケージ: `npm run app:dist`（現状 macOS ターゲット）
