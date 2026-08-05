import type { NodeType } from "./types";

// UI で見せる日本語ラベル。内部名 / MCP API 名 (image_gen, video_gen, ...) は
// そのまま使い、画面に出すときだけこちらを経由する。
export const NODE_LABELS: Record<NodeType, string> = {
  image_gen: "画像生成",
  image_edit: "画像編集",
  video_gen: "動画生成",
  image_upload: "画像アップロード",
  video_upload: "動画アップロード",
  audio_upload: "オーディオアップロード",
  video_upscale: "動画アップスケール",
  audio_gen: "音声生成",
  video_to_audio: "動画→音声",
  transcribe: "文字起こし",
  llm_text: "テキスト生成 (LLM)",
  av_mux: "音声を合成",
  video_concat: "動画連結",
  video_trim: "動画トリム",
  frame_extract: "フレーム抽出",
  note: "メモ",
  doc: "ドキュメント",
  web_clip: "Webクリップ",
  file_import: "ファイル取込",
  frame: "枠",
};

export function labelOf(t: NodeType): string {
  return NODE_LABELS[t] ?? t;
}

// 入出力ポートの日本語表示名 (内部識別子はそのまま使う)
export const PORT_LABELS: Record<string, string> = {
  // image / video media
  image_in: "入力画像",
  ref_in: "参照画像",
  last_frame_in: "末尾フレーム",
  mask_in: "マスク",
  audio_in: "入力オーディオ",
  video_in: "入力動画",
  ref_video_in: "参照動画",
  ref_audio_in: "参照オーディオ",
  clip_in: "クリップ",
  text_in: "テキスト入力",
  image_out: "画像出力",
  video_out: "動画出力",
  audio_out: "オーディオ出力",
  text_out: "テキスト出力",
};

export function labelOfPort(p: string): string {
  return PORT_LABELS[p] ?? p;
}
