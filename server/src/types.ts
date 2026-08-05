// Canonical data model — the single source of truth for the canvas.
// (spec §1)

export type NodeType =
  | "image_gen"
  | "image_edit"
  | "video_gen"
  | "image_upload"
  | "video_upload"
  | "audio_upload"
  | "video_upscale"
  // Pika's audio catalog (TTS, sound effects, music, speech-to-speech,
  // voice isolation, dubbing) — everything whose output is an audio track.
  | "audio_gen"
  // Scoring an existing cut: video in, music/SFX track out.
  | "video_to_audio"
  // Speech -> text (Whisper / ElevenLabs Scribe).
  | "transcribe"
  // Pika's LLM catalog through the OpenAI-compatible chat surface.
  | "llm_text"
  // builtin/ffmpeg: lay an audio track over a video (the other half of scoring).
  | "av_mux"
  | "video_concat"
  | "frame_extract"
  | "video_trim"
  | "note"
  | "doc"
  | "web_clip"
  | "file_import"
  | "frame";

export type NodeStatus =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type PortOut = "image_out" | "video_out" | "audio_out" | "text_out";
export type PortIn =
  | "image_in"
  | "ref_in"
  | "last_frame_in"
  | "mask_in"
  | "video_in"
  | "ref_video_in"
  | "audio_in"
  | "ref_audio_in"
  | "clip_in"
  | "text_in";

export type OutputKind = "image" | "video" | "audio" | "text";

export interface OutputMeta {
  width?: number;
  height?: number;
  durationSec?: number;
  provider: string;
  model: string;
  // number = the amount actually charged for this output.
  // null   = the model is metered on a unit we cannot convert (per-million
  //          output tokens), so the charge is real but unknown here. It is NOT
  //          zero, and anything summing costs must report it separately.
  cost?: number | null;
  // Whatever usage counters the provider reported for this output, kept raw so
  // a real figure can be reconciled later without re-running anything.
  usage?: Record<string, unknown>;
  seed?: number;
}

export interface Output {
  id: string;
  kind: OutputKind;
  url: string; // served by the local server (empty for text outputs)
  text?: string; // inline content for text outputs
  thumbUrl?: string;
  meta: OutputMeta;
  createdAt: string;
}

export interface NodeData {
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  outputs: Output[];
}

export interface GraphNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
  status: NodeStatus;
  error?: string;
}

export interface Edge {
  id: string;
  source: string;
  sourceHandle: PortOut;
  target: string;
  targetHandle: PortIn;
}

export interface Graph {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: Edge[];
  viewport: { x: number; y: number; zoom: number };
  updatedAt: string;
}

// --- Provider layer ---

export interface ResolvedInput {
  port: PortIn;
  kind: OutputKind;
  url: string; // for image/video inputs ("" for text)
  text?: string; // for text inputs
}

export interface RawOutput {
  kind: OutputKind;
  url: string; // provider-side url (often temporary) — core downloads it
  text?: string; // inline result for text outputs (LLM / transcription); no download
  // Headers the core downloader must send to fetch `url`. Pika serves results
  // from two hosts with opposite rules — the CDN 403s a request carrying the
  // API key, the API host 403s one without it — so the adapter decides.
  fetchHeaders?: Record<string, string>;
  width?: number;
  height?: number;
  durationSec?: number;
  seed?: number;
}

export interface CostEstimate {
  amount: number;
  currency: "USD";
  note?: string;
  // true when the unit cannot be quoted up front. `amount` is 0 in that case
  // purely as a placeholder — treat it as "unknown", never as "free".
  metered?: boolean;
}

export interface ProviderRunArgs {
  prompt: string;
  params: Record<string, unknown>;
  inputs: ResolvedInput[];
}

export interface ProviderRunResult {
  outputs: RawOutput[];
  cost: number | null; // null = metered on an unquotable unit (see OutputMeta.cost)
  usage?: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: "pika" | "mock";
  supports(model: string): boolean;
  estimateCost(
    model: string,
    params: Record<string, unknown>,
    inputs: ResolvedInput[],
    // Some models are billed per character of input (TTS), so the estimate
    // cannot be computed from params alone.
    prompt?: string,
  ): CostEstimate;
  run(model: string, args: ProviderRunArgs): Promise<ProviderRunResult>;
}

// --- Model registry ---

export interface ModelSpec {
  id: string; // "pika/<vendor>/<model>/<function>", or "builtin/…"
  provider: "pika" | "mock" | "builtin";
  path: string; // request path for pika models, e.g. "/v1/media/kling/kling-3.0/image-to-video"
  label: string; // human name from the catalog, e.g. "Kling 3.0 (Image to Video)"
  kind: OutputKind; // primary output kind
  nodeTypes: NodeType[]; // which node types may use this model
  paramSchema: ParamField[];
  defaults: Record<string, unknown>;
  priceHint: string;
  description?: string;
}

export interface ParamField {
  key: string;
  label: string;
  type: "string" | "number" | "select";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  // How to coerce the UI's string value back to what the API expects. Generated
  // from the endpoint's JSON Schema — "loose" means decide per value (Seedance's
  // duration accepts either an integer or the literal "auto").
  valueType?: "string" | "number" | "integer" | "boolean" | "loose";
  description?: string;
  maxLength?: number;
  // The endpoint declares this field required. Generated fields carry a
  // concrete default where one can be derived; the few that cannot (a voice id,
  // a target language) stay blank, and the adapter refuses to run until set.
  required?: boolean;
}

// --- Jobs ---

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  nodeId: string;
  status: JobStatus;
  progress: number; // 0..1
  error?: string;
  estimate?: CostEstimate;
  createdAt: string;
}
