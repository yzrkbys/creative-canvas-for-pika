// Mirror of the Canvas Server data model (the parts the UI renders).
export type NodeType =
  | "image_gen"
  | "image_edit"
  | "video_gen"
  | "image_upload"
  | "video_upload"
  | "audio_upload"
  | "video_upscale"
  | "audio_gen"
  | "video_to_audio"
  | "transcribe"
  | "llm_text"
  | "av_mux"
  | "video_concat"
  | "frame_extract"
  | "note"
  | "doc"
  | "web_clip"
  | "file_import"
  | "frame";
export type NodeStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
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

export interface Output {
  id: string;
  kind: OutputKind;
  url: string;
  text?: string;
  thumbUrl?: string;
  meta: {
    width?: number;
    height?: number;
    durationSec?: number;
    provider: string;
    model: string;
    cost?: number;
    seed?: number;
  };
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

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export interface ParamField {
  key: string;
  label: string;
  type: "string" | "number" | "select";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  valueType?: "string" | "number" | "integer" | "boolean" | "loose";
  description?: string;
  maxLength?: number;
  required?: boolean;
}

export interface ModelSpec {
  id: string;
  provider: string;
  path: string;
  label: string;
  kind: OutputKind;
  nodeTypes: NodeType[];
  paramSchema: ParamField[];
  defaults: Record<string, unknown>;
  priceHint: string;
  description?: string;
}

export type ServerEvent =
  | { type: "node:added"; node: GraphNode }
  | { type: "node:updated"; node: GraphNode }
  | { type: "node:deleted"; id: string }
  | { type: "edge:added"; edge: Edge }
  | { type: "edge:removed"; id: string }
  | { type: "node:status"; id: string; status: NodeStatus; error?: string }
  | { type: "node:output"; id: string; output: Output }
  | { type: "viewport"; viewport: Graph["viewport"] };

export type RunResult =
  | { jobId: string }
  | { needConfirm: true; estimate: { amount: number; currency: string; note?: string } };
