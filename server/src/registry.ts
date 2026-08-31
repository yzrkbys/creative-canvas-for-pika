import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelSpec, NodeType, OutputKind, ParamField } from "./types.js";
import { BASE_DIR } from "./paths.js";
import bundledCatalog from "./pika-catalog.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Model registry
//
// Unlike a hand-written table, this is *derived*: Pika publishes every
// endpoint's JSON Schema and price tiers at GET /catalog/apis, and
// scripts/sync-catalog.mjs turns that into pika-catalog.json. Adding a model
// therefore means re-running the sync, not writing an adapter branch.
//
// A newer snapshot dropped into the writable data dir wins over the bundled
// one, so the desktop app can pick up new Pika models without a rebuild.
// ---------------------------------------------------------------------------

export interface CatalogMediaField {
  field: string;
  kinds: OutputKind[];
  array: boolean;
  required: boolean;
  maxItems?: number;
  minItems?: number;
  /**
   * Set when the array holds OBJECTS rather than bare URLs: the property inside
   * each object that carries the media URL (FLUX 3 keyframes -> "image_url").
   */
  itemField?: string;
  /** Scalar siblings of `itemField`, exposed as `<field>_<key>` params. */
  itemExtras?: { key: string; label: string; description?: string; required: boolean }[];
}

export interface CatalogPricing {
  unit: string;
  quantity: number;
  tiers: { spec: Record<string, string>; usd: number }[];
  inputUsd?: number;
}

export interface CatalogAdvancedField {
  key: string;
  label: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

export interface CatalogEntry {
  apiId: string;
  vendor: string;
  fn: string | null;
  category: string;
  name: string;
  description: string;
  method: string;
  path: string;
  textField: string | null;
  textMaxLength?: number;
  media: CatalogMediaField[];
  params: ParamField[];
  defaults: Record<string, unknown>;
  advanced: CatalogAdvancedField[];
  requiredAdvanced: string[];
  requiredFields: string[];
  pricing: CatalogPricing | null;
}

interface CatalogFile {
  syncedAt: string;
  base: string;
  entries: CatalogEntry[];
}

function loadCatalog(): CatalogFile {
  const override = path.join(BASE_DIR, "pika-catalog.json");
  try {
    const parsed = JSON.parse(readFileSync(override, "utf8")) as CatalogFile;
    if (Array.isArray(parsed.entries) && parsed.entries.length) {
      console.log(
        `[registry] using synced catalog ${override} (${parsed.entries.length} models, ${parsed.syncedAt})`,
      );
      return parsed;
    }
  } catch {
    /* no override — the bundled snapshot is the normal case */
  }
  return bundledCatalog as CatalogFile;
}

export const CATALOG = loadCatalog();

// A catalog entry's `function` decides which node type can run it. The canvas
// deliberately keeps one node per *output shape* rather than one per function,
// so a single video_gen node switches between t2v / i2v / r2v / v2v just by
// changing model — the ports it needs come from the model's own schema.
const NODE_TYPE_BY_FUNCTION: Record<string, NodeType> = {
  "text-to-image": "image_gen",
  "image-to-image": "image_edit",
  "image-upscale": "image_edit",

  "text-to-video": "video_gen",
  "image-to-video": "video_gen",
  "reference-to-video": "video_gen",
  "video-to-video": "video_gen",
  "video-extension": "video_gen",
  "motion-control": "video_gen",
  "omni-video": "video_gen",
  avatar: "video_gen",
  "video-upscale": "video_upscale",

  "text-to-speech": "audio_gen",
  "text-to-audio": "audio_gen",
  "sound-effects": "audio_gen",
  "speech-to-speech": "audio_gen",
  "voice-isolation": "audio_gen",
  dubbing: "audio_gen",
  "video-to-audio": "video_to_audio",
  // Sonilo renamed its scoring endpoints (video-to-audio -> video-to-music);
  // without these the whole family silently drops out of the registry.
  "video-to-music": "video_to_audio",
  "video-to-sound-effects": "video_to_audio",
  "text-to-music": "audio_gen",
  // Pika's own audio family names each endpoint after itself rather than after
  // its shape, so every one of them needs an explicit row.
  "pika-music": "audio_gen",
  "pika-sfx": "audio_gen",
  "pika-speech": "audio_gen",
  // Video in, score out — the same shape as Kling's and Sonilo's scorers.
  // Pika describes it as replacing the audio on the supplied video, so the
  // result may well be a remuxed VIDEO rather than a bare track (as Kling
  // Audio already returns an m4a carrying a picture stream). Either way the
  // audio is what the downstream av_mux takes, so this node type holds; if a
  // run shows it returning picture worth keeping, move it to video_gen the
  // way sonilo's video-to-scored-video is routed.
  "pika-soundtrack": "video_to_audio",
  // Returns a scored VIDEO, not a bare track — it belongs on a video node.
  "video-to-scored-video": "video_gen",
  // Output is text, not audio — routing on category alone would misplace this.
  transcription: "transcribe",
};

const KIND_BY_NODE_TYPE: Partial<Record<NodeType, OutputKind>> = {
  image_gen: "image",
  image_edit: "image",
  video_gen: "video",
  video_upscale: "video",
  audio_gen: "audio",
  video_to_audio: "audio",
  transcribe: "text",
  llm_text: "text",
};

const UNIT_LABEL: Record<string, string> = {
  second: "秒",
  output_second: "秒",
  image: "枚",
  minute: "分",
  character: "字",
  request: "回",
};

/**
 * Units whose quantity cannot be known before running. Pika meters several
 * models per million output tokens with no published mapping to seconds or
 * pixels, so any pre-run figure for them would be invented.
 */
export function isOpaqueUnit(unit: string): boolean {
  return unit.endsWith("_token");
}

function priceHintOf(p: CatalogPricing | null): string {
  if (!p || !p.tiers.length) return "価格情報なし";
  const amounts = p.tiers.map((t) => t.usd).sort((a, b) => a - b);
  const lo = amounts[0];
  const hi = amounts[amounts.length - 1];
  const money = lo === hi ? `$${lo}` : `$${lo}–${hi}`;
  if (isOpaqueUnit(p.unit)) return `${money} / 1M ${p.unit}（数量不明・事前見積り不可）`;
  const unit = UNIT_LABEL[p.unit] ?? p.unit;
  return `${money} / ${p.quantity === 1 ? unit : `${p.quantity}${unit}`}`;
}

// Taste layer for param defaults — the same status as PREFERRED_DEFAULT below.
// The sync picks required values mechanically (first enum option), which is
// defensible but occasionally lands on a tier nobody works at. Overrides are
// applied only when the model really has that param and really accepts the
// value, so a catalog change silently drops the override instead of breaking.
const PREFERRED_PARAMS: { match: (apiId: string) => boolean; params: Record<string, unknown> }[] = [
  // Seedance's resolution enum starts at 480p — a proxy tier, not a working one.
  { match: (id) => id.startsWith("bytedance/seedance-"), params: { resolution: "720p" } },
];

function applyPreferredParams(entry: CatalogEntry): Record<string, unknown> {
  const out = { ...entry.defaults };
  for (const rule of PREFERRED_PARAMS) {
    if (!rule.match(entry.apiId)) continue;
    for (const [key, value] of Object.entries(rule.params)) {
      const field = entry.params.find((f) => f.key === key);
      if (!field) continue;
      if (field.options && !field.options.includes(String(value))) continue;
      out[key] = value;
    }
  }
  return out;
}

function specOf(entry: CatalogEntry): ModelSpec | null {
  const nodeType = entry.category === "llm" ? "llm_text" : NODE_TYPE_BY_FUNCTION[entry.fn ?? ""];
  if (!nodeType) {
    console.warn(
      `[registry] skipping ${entry.apiId}: no node type for function "${entry.fn}" — ` +
        "add it to NODE_TYPE_BY_FUNCTION in registry.ts",
    );
    return null;
  }
  const kind = KIND_BY_NODE_TYPE[nodeType];
  if (!kind) return null;

  // A handful of endpoints take structured arrays (ElevenLabs dialogue turns,
  // Kling omni-video contents) that no simple widget can express. Give just
  // those models a raw-JSON field so they stay reachable instead of dead.
  const paramSchema: ParamField[] = entry.advanced.length
    ? [
        ...entry.params,
        {
          key: "_json",
          label: `詳細JSON（${entry.advanced.map((a) => a.key).join(", ")}）`,
          type: "string",
          description: entry.advanced
            .map((a) => `${a.key}${a.required ? "（必須）" : ""}: ${a.description ?? a.label}`)
            .join("\n"),
        },
      ]
    : entry.params;

  return {
    id: `pika/${entry.apiId}`,
    provider: "pika",
    path: entry.path,
    label: entry.name,
    kind,
    nodeTypes: [nodeType],
    paramSchema,
    defaults: applyPreferredParams(entry),
    priceHint: priceHintOf(entry.pricing),
    description: entry.description,
  };
}

const PIKA_MODELS: ModelSpec[] = CATALOG.entries
  .map(specOf)
  .filter((m): m is ModelSpec => m !== null);

// Pika renames an endpoint family in place from time to time
// (google/gemini-omni-1.1 -> google/gemini-omni-1.1-flash, 2026-08-28). A graph
// stores the model id it was built with, so a rename orphans every node that
// used it: settings and wiring intact, but "no valid model" the moment it runs.
// Old ids therefore keep resolving to their successor. Prefix pairs, because a
// rename hits every function under the family at once.
const RENAMED_API_PREFIXES: [string, string][] = [
  ["google/gemini-omni-1.1/", "google/gemini-omni-1.1-flash/"],
  // Sonilo's scorer, renamed earlier — the same rename NODE_TYPE_BY_FUNCTION
  // already accounts for above. An exact id, not a family prefix.
  ["sonilo/sonilo-v1.1-music/video-to-audio", "sonilo/sonilo-v1.1-music/video-to-music"],
];

function currentApiId(apiId: string): string {
  for (const [from, to] of RENAMED_API_PREFIXES) {
    if (apiId.startsWith(from)) return to + apiId.slice(from.length);
  }
  return apiId;
}

/**
 * The id a saved node should be using today. Unchanged for everything that was
 * never renamed, so it is safe to run every stored id through it.
 */
export function currentModelId(id: string): string {
  if (!id.startsWith("pika/")) return id;
  return "pika/" + currentApiId(id.slice("pika/".length));
}

/** The generated catalog entry behind a model id — the adapter builds requests from it. */
export function getEntry(modelId: string): CatalogEntry | undefined {
  const apiId = modelId.startsWith("pika/") ? modelId.slice("pika/".length) : modelId;
  return (
    CATALOG.entries.find((e) => e.apiId === apiId) ??
    CATALOG.entries.find((e) => e.apiId === currentApiId(apiId))
  );
}

// ---------------------------------------------------------------------------
// builtin models (not Pika): free local utilities.
// ---------------------------------------------------------------------------

const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: "builtin/web-clip",
    provider: "builtin",
    path: "web-clip",
    label: "Web クリップ",
    kind: "text",
    nodeTypes: ["web_clip"],
    priceHint: "free (fetch)",
    paramSchema: [
      { key: "url", label: "URL", type: "string" },
      { key: "maxChars", label: "Max chars", type: "number", min: 500, max: 50000, step: 500 },
    ],
    defaults: { url: "", maxChars: 12000 },
  },
  {
    id: "builtin/video-trim",
    provider: "builtin",
    path: "video-trim",
    label: "動画トリム",
    kind: "video",
    nodeTypes: ["video_trim"],
    priceHint: "free (ffmpeg)",
    paramSchema: [
      { key: "start", label: "Start (s | 0 | NN%)", type: "string" },
      { key: "end", label: "End (s | last | NN%)", type: "string" },
    ],
    defaults: { start: "0", end: "last" },
  },
];

export const MODELS: ModelSpec[] = [...PIKA_MODELS, ...BUILTIN_MODELS];

// What a freshly-added node starts on. This is the one place in the model layer
// that reflects taste rather than the API: catalog order would land a new video
// node on happyhorse-1.0/image-to-video. Anything missing from a future catalog
// falls back to the first model that fits the node type.
const PREFERRED_DEFAULT: Partial<Record<NodeType, string>> = {
  image_gen: "pika/bytedance/seedream-5.0-pro/text-to-image",
  image_edit: "pika/openai/gpt-image-2/image-to-image",
  video_gen: "pika/bytedance/seedance-2.0/reference-to-video",
  video_upscale: "pika/topaz/topaz-video-upscale/video-upscale",
  audio_gen: "pika/elevenlabs/eleven-multilingual-v2/text-to-speech",
  // video-to-audio here was stale — Sonilo renamed it to video-to-music and this
  // pointer kept naming an endpoint the catalog no longer has, so new nodes fell
  // through to catalog order instead of the model meant to be picked.
  video_to_audio: "pika/sonilo/sonilo-v1.1-music/video-to-music",
  transcribe: "pika/openai/whisper/transcription",
  llm_text: "pika/anthropic/claude-opus-5",
};

export function getModel(id: string): ModelSpec | undefined {
  const hit = MODELS.find((m) => m.id === id);
  if (hit) return hit;
  const renamed = currentModelId(id);
  return renamed === id ? undefined : MODELS.find((m) => m.id === renamed);
}

export function modelsForType(type: NodeType): ModelSpec[] {
  return MODELS.filter((m) => m.nodeTypes.includes(type));
}

export function defaultModelFor(type: NodeType): string {
  const preferred = PREFERRED_DEFAULT[type];
  if (preferred && MODELS.some((m) => m.id === preferred)) return preferred;
  const m = modelsForType(type)[0];
  return m ? m.id : "";
}
