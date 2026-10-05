# Creative Canvas for Pika API Club

> **非公式プロジェクトです。** 個人が作ったもので、Pika 社とは無関係であり、同社による承認・後援も
> 受けていません。「Pika」「Pika API Club」は、このアプリがどのAPIを叩くのかを示すためだけに
> 使っています。API の利用には Pika の利用規約が適用され、生成物の課金はあなた自身の
> Pika アカウントに紐づきます。

[English](README.md) | 日本語

![字コンテ→キャラシート→背景→デプスマップ→R2V→音楽までを1枚のキャンバスで](docs/screenshot-canvas.png)

画像・動画・音声・テキストの生成をノードで繋ぐ、デスクトップ版のクリエイティブ・キャンバスです。
生成はすべて **Pika API** に一本化されているので **APIキー1本**でカタログ全体に届き、内蔵の
**MCP サーバ**経由で **Claude Code** にグラフの組み立てと実行を任せられます。

- Electron アプリ（内蔵サーバ ＋ React キャンバス）
- MCP サーバ同梱。エージェントがノードの追加・接続・生成まで行えます
- 生成データはすべて**各自の端末ローカル**に保存され、このプロジェクトには何も送られません

UI は日本語です。モデルカタログとプロンプトは英語です。

---

## なぜ作ったか

プロバイダを横断するキャンバスの多くは、モデルごとに手書きのアダプタを抱えています。
パラメータを列挙し、既定値を推測し、価格をハードコードしたファイルです。プロバイダが
新しいエンドポイントを出した日から腐りはじめます。

Pika は全エンドポイントの **JSON Schema と価格ティア**を公開しているので、このアプリには
**手書きのモデル定義が1つもありません**。モデル層はカタログから生成され（`npm run sync:catalog`）、
モデルの追加は「同期を再実行するだけ」でコードは書きません。手で保守するのは、メディアの
フィールド名をキャンバスのポートに対応させる小さな表だけです。

ノードの種類が少ないのも同じ理由です。`video_gen` ひとつで t2v / i2v / first-last-frame /
reference-to-video / video-to-video / extension / motion-control / avatar を賄います。
どのポートが要るかはモデル側のスキーマが決めるからです。

---

## 必要なもの

- **Node.js 18 以上**（LTS 推奨）… https://nodejs.org
- **git**
- **Pika の APIキー** … https://dev.pika.art で発行
  - 画像・動画・音声・LLM の全モデルがこのキー1本で動きます。**成功した生成のみ課金**されます。
  - キーが無くても `MOCK_PROVIDER=1` でプレースホルダ生成の動作確認ができます（無料）。
- **ffmpeg / ffprobe** … ローカル実行のノード（連結・トリム・フレーム抽出・音声合成）用。
  - macOS: `brew install ffmpeg`
  - Windows: PowerShell で `winget install Gyan.FFmpeg`（入れたらアプリを再起動）
- **Claude Code** … 必須ではありませんが、MCP 側はこれで動かす前提の設計です。

**macOS（Apple Silicon）** と **Windows 10 / 11（x64）** に対応しています。Windows 向けのビルドと
スモークテスト（`desktop/smoke.mjs`）は GitHub Actions の Windows ランナーで回します
（`.github/workflows/windows.yml`）。

---

## インストール

```bash
git clone https://github.com/yzrkbys/creative-canvas-for-pika.git
cd creative-canvas-for-pika
npm install
npm run app
```

`npm run app` で web とサーバをビルドし、デスクトップアプリを起動します。
Windows でも同じコマンドを PowerShell（またはコマンドプロンプト）で実行します。

**APIキーの設定**はメニューから: **Canvas → 設定（APIキー）を開く**。開いたファイル
（Windows ではメモ帳で開きます）に `PIKA_API_KEY=...` を貼って保存し、**Canvas → 設定を反映して再起動**
を選んでください。キーはユーザーデータディレクトリに保存され、リポジトリには入りません。

### Windows のインストーラを書き出す

```bash
npm run app:dist:win    # → desktop/release/CreativeCanvasForPika-Setup-<version>.exe
```

Windows 上で実行するのが基本ですが、macOS からもクロスビルドできます（初回は Electron の
Windows 版と NSIS をダウンロードします）。インストーラはユーザー単位でインストールするので
管理者権限は要りません。アンインストールしても作業データ（`%APPDATA%` 側）は残ります。

ビルドは**未署名**なので、初回起動時に SmartScreen が「Windows によって PC が保護されました」と
出します。**詳細情報 → 実行**で起動してください。表示を出さないにはコード署名証明書が必要です。

### `.app` を書き出す（macOS）

```bash
npm run app:dist        # → desktop/release/
```

ビルドは**未署名**なので、macOS は初回の起動を拒否します（「壊れている」「開けません」）。
アプリを右クリック →**「開く」**を選ぶか、隔離属性を外してください。

```bash
xattr -dr com.apple.quarantine "/Applications/Creative Canvas for Pika API Club.app"
```

自分で署名するには Apple Developer ID が必要です。

---

## Claude Code から動かす

このフォルダを Claude Code で開くと、同梱の `.mcp.json` が **`creative-canvas-pika`** という名前で
MCP サーバを登録します（`creative-canvas` にしていないのは、別のキャンバスを登録していても
共存できるようにするためです）。先にデスクトップアプリを起動してから（MCP は `127.0.0.1:8797`
経由で通信します）、チャットで指示するだけです。MCP は `npx` を介さず `node` で直接起動するので、
Windows でも `cmd /c` などの包み方は要りません。

- 「『夕焼けの富士山』の画像ノードを作って生成して」
- 「この画像から5秒の動画を作って」
- 「このカットに劇伴を付けて、映像に合成して」

作られたノードはキャンバスにリアルタイムで現れます。

---

## ノードの種類

| グループ | ノード | 入力 → 出力 |
|---|---|---|
| 画像 | `image_gen` · `image_edit` · `image_upload` | text・画像 → 画像 |
| 動画 | `video_gen` · `video_upscale` · `video_trim` · `video_concat` · `frame_extract` · `video_upload` | text・画像・動画・音声 → 動画 |
| 音声 | `audio_gen` · `video_to_audio` · `av_mux` · `transcribe` · `audio_upload` | text・音声・動画 → 音声（`transcribe` はテキスト） |
| テキスト | `llm_text` · `note` · `doc` · `web_clip` · `file_import` | text → text |
| レイアウト | `frame` | 視覚的なグルーピング枠 |

ffmpeg で動くノード（`video_trim` `video_concat` `frame_extract` `av_mux`）と `web_clip` は
ローカル実行なので無料です。`video_concat` は既定の「ローカル連結（ffmpeg）」が映像だけを繋ぐので、
各クリップの音声を残したいときはモデルを **Pika Video Merge**（2〜10本・$0.0002/秒）に切り替えてください。
どちらもクリップは左→右の並び順で繋がります。

**スコアリングの往復**がキャンバス内で閉じます:
`video_gen → video_to_audio`（カットに劇伴/SEを付ける）`→ av_mux`（映像に戻す）。

### 生成中に内容を確認する

生成中のノードでも **「設定」** や **「内容を確認」** から設定パネルを開けます。先頭の
**「実行中の内容」** に、そのジョブに実際に送ったものが出ます。

- モデル、プロンプト（上流のテキストノードから来た場合はそう表示）、パラメータ、入力のサムネイル
- 経過時間、見積り、**Pika ジョブID**（コピー可。Pika 側での照会や下記のドラフト確定に使います）

ジョブは**開始時の内容で固定**されるので、生成中にプロンプトやモデルを書き換えても実行中のジョブには
影響せず、次回の実行から反映されます。完了した出力にも「何で作ったか」が記録されるので、再生成で
アーカイブに回った前の結果は、その結果を作ったときのモデルとプロンプトを持ったまま残ります。

**Seedance 2.5 のドラフト**: `draft` を on にすると 480p のドラフトで先に確認できます。気に入ったら、
そのジョブIDを「Seedance 2.5 Draft To Video」の Draft Job Id に貼ると、プロンプトや入力を引き継いだ
1080p の本番を書き出せます（7日以内・本番は別ジョブとして課金）。

---

## モデルレジストリの仕組み（カタログ駆動）

Pika は `GET /catalog/apis` と `GET /catalog/apis/{api_id}?expand=inputs` で全エンドポイントの
スキーマと価格を返します。同期スクリプトはそれを `server/src/pika-catalog.json` に変換します。

```bash
npm run sync:catalog
# アーリーアクセスのモデルはキーが要ります: PIKA_API_KEY=... npm run sync:catalog
```

スキーマから導出されるもの:

- **パラメータUI** … enum はセレクト、整数は数値入力、`anyOf:[整数4-15, "auto"]` のような
  合成型も1つの選択肢リストに展開されます
- **既定値** … スキーマが宣言したものだけ。宣言が無ければ「（モデル既定）」＝**フィールドを送りません**。
  先頭の enum 値を勝手に既定にすると、誰も選んでいないのに Seedance が 480p や 1:1 に固定されます
- **ポート結線** … `media_kinds` 注釈から、どのフィールドが画像/動画/音声を取るかを判定します
- **コスト** … 価格ティアの `spec` をノードのパラメータと突き合わせて単価を選びます

カタログにポート対応の無いメディアフィールドが増えると、同期は**明示的に失敗して止まります**。
黙って入力を落としたまま課金するよりよいからです。

アプリを再ビルドせずに新モデルを反映したい場合は、生成した `pika-catalog.json` を
下記のユーザーデータディレクトリに置いて再起動してください。同梱版より優先されます。

### コスト表示の意味

課金単位はモデルによって違い、**事前に金額を出せないものがあります**。

| 単位 | 例 | 事前見積り |
|---|---|---|
| 秒 | Kling, Veo, Wan | ○ 単価 × 尺 |
| 枚 | Seedream, GPT-Image | ○ 単価 × 枚数 |
| 文字 | ElevenLabs TTS | ○ 単価 × プロンプト文字数 |
| 回 | 一部モデル | ○ 定額 |
| 分 | Sonilo スコアリング | △ 入力動画の尺に比例 |
| トークン | Seedance, Gemini Omni, LLM | **✗ 生成量が事前に不明** |

トークン課金のモデルは金額を捏造せず「事前見積り不可」と表示して確認を求めます。
**`$0` は「無料」ではなく「見積り不能」**という意味です。

---

## 課金前に止まるガード

配線ミスは**アップロードや送信より前に**ローカルで検出して止めます。

- 必須のメディア入力が未接続
- そのモデルが**読まないポート**にメディアが繋がっている（t2i モデルに参照画像、など）
- 単数フィールドへの複数接続 / 配列フィールドの上限超過
- プロンプトがモデルの文字数上限を超過
- 構造化パラメータ（ElevenLabs のダイアログ、Kling omni-video）が未指定

いずれも「どのポートを外すか／どこに繋ぐか」をエラー文で示します。

---

## データの保存場所

- macOS: `~/Library/Application Support/Creative Canvas for Pika API Club/`
- Windows: `%APPDATA%\Creative Canvas for Pika API Club\`

プロジェクト・生成物・`.env`（APIキー）はすべてここにあり、リポジトリには含まれません。
メニューの **Canvas → 保存フォルダを開く** から開けます。

> **旧名からの移行**: このアプリは 2026-09-02 まで *Pika Canvas* という名前でした。初回起動時に
> 旧 `Pika Canvas` フォルダを新しい名前へ移動するので、既存プロジェクトはアプリに付いてきます。
> 移動に失敗した場合は旧フォルダを使い続け、その旨をログに出します。**作業データが取り残される
> ことはありません。**

---

## トラブルシューティング

**起動しても空のウィンドウ／「サーバ未接続」になる。**
内蔵サーバの起動に失敗しています。ターミナルから `npm run app` で起動するとログが見えます。
よくある原因はポート `8797` の使用中で、その場合アプリは空きポートに退避し、データディレクトリの
`server-port` に実際のポートを書きます。

**生成が `file too large` で失敗する。**
Pika のアップロード上限は **100 MiB**（正確に 104,857,600 バイト）で、拒否は1バイトも送る前に
起きます。生成したクリップは簡単にこれを超えます（30秒 1080p で 200 MiB 超になることがあります）。

モデルがその動画を**解析するだけ**で別のものを返す場合（スコアリング・文字起こし）は、720p 上限・
音声ストリームは無変換コピーで**自動的に再エンコードして送り**、その旨をログに出します。
入力の画がそのまま出力に載る場合（v2v・extension・アップスケール）は再エンコードせず**停止します**。
master を黙って縮小する方が悪い失敗だからです（気づけません）。`video_trim` で短くするか、
小さく再エンコードしたものを取り込んで繋いでください。

**動画ジョブが30分経っても終わらない。**
本当にそれだけ掛かるモデルがあります（アーリーアクセスのモデルで30秒クリップが44〜55分という
実測があります）。アプリは最大180分ポーリングします。早々に諦めると、Pika 側では走り続けて
**課金され続けている**ジョブを見失うためです。

**`ffmpeg の起動に失敗しました` と出る。**
ffmpeg が見つかっていません。アプリは `PATH` に加えて、Homebrew（macOS）と winget / scoop /
Chocolatey / `C:\ffmpeg\bin`（Windows）の標準の場所を探します。インストール直後ならアプリを再起動し、
それでも駄目なら設定ファイルに `PIKA_CANVAS_FFMPEG` と `PIKA_CANVAS_FFPROBE` で場所を書いてください
（例: `PIKA_CANVAS_FFMPEG=C:\ffmpeg\bin\ffmpeg.exe`）。

**モデル名の横に ⚠ が出る / 「現在の Pika カタログにありません」と出る。**
Pika が提供を終えたモデルです（2026-10 の同期では `deepseek-v4-flash` と `eleven-music` の効果音が
終了）。ノードの「設定」から別のモデルを選び直してください。課金前に止まるので、費用は掛かっていません。

**WSL2 など別の環境から MCP で繋ぎたい。**
内蔵サーバは安全のため `127.0.0.1` だけで待ち受けます（LAN に課金APIを晒さず、Windows で
ファイアウォールの確認も出さないため）。外から繋ぐ必要がある場合だけ、設定ファイルに
`PIKA_CANVAS_HOST=0.0.0.0` を書いて再起動してください。

**Pika のサイトで見えるモデルが一覧に出ない。**
キー付きで同期し直してください（`PIKA_API_KEY=... npm run sync:catalog`）。アーリーアクセスの
モデルは、許可されたキーでしかカタログに現れません。なお、カタログには function を宣言しない
ベンダー別名の行が混じることがあり、これは意図的にスキップしています（実体のエンドポイントは
すでに一覧にあります）。

---

## 開発

```bash
npm run dev          # サーバ :8797 ＋ Vite :5173
npm run typecheck    # server / mcp / web
```

構成: `server/`（Express + WebSocket API）· `web/`（React + React Flow）· `mcp/`（stdio MCP → HTTP）
· `desktop/`（Electron シェル）

動かしているアプリを止めずに検証したい場合は、別ポート＋別データディレクトリで
2つ目のサーバを起動してください。

```bash
PORT=8891 PIKA_CANVAS_DATA_DIR=/tmp/canvas-dev node_modules/.bin/tsx server/src/index.ts
```

Windows（PowerShell）では:

```powershell
$env:PORT=8891; $env:PIKA_CANVAS_DATA_DIR="$env:TEMP\canvas-dev"; node node_modules/tsx/dist/cli.mjs server/src/index.ts
```

`MOCK_PROVIDER=1` を足すと無課金で動き、`MOCK_LATENCY_MS=20000` で生成中の表示をゆっくり確かめられます。
パッケージに入るサーバ一式は `npm -w desktop run build:all && npm -w desktop run smoke` で
モックのまま一通り（生成・ffmpeg 連結）検査できます。

---

## ライセンス

MIT（[LICENSE](LICENSE)）。

MIT が及ぶのはこのソースコードのみです。Pika の API・サービス・商標に関する権利は一切
含みません。API の利用には Pika の利用規約が適用され、生成物の権利と費用はあなたと
Pika の間の問題です。
