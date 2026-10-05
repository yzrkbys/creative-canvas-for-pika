import { EventEmitter } from "node:events";
import path from "node:path";
import { promises as fs } from "node:fs";
import { nanoid } from "nanoid";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { concatVideos, extractFrame, muxAudio, probeDuration, trimVideo } from "./ffmpeg.js";
import { projectAssetsDir, resolveAssetPath } from "./paths.js";
import {
  connectionValid,
  requiredInputs,
  inputKindOf,
  PORTS,
  MULTI_INPUT_PORTS,
} from "./ports.js";
import { getModel, defaultModelFor, MODELS, BUILTIN_CONCAT_MODEL } from "./registry.js";
import { adapterFor } from "./providers/index.js";
import { downloadToAssets, saveBytesToAssets } from "./assets.js";
import { saveProjectGraph } from "./persistence.js";
import type {
  CostEstimate,
  Edge,
  Graph,
  GraphNode,
  Job,
  ModelSpec,
  NodeStatus,
  NodeType,
  Output,
  PortIn,
  PortOut,
  ResolvedInput,
  RunInfo,
  RunRequest,
} from "./types.js";

export type CanvasEvent =
  | { type: "node:added"; node: GraphNode }
  | { type: "node:updated"; node: GraphNode }
  | { type: "node:deleted"; id: string }
  | { type: "edge:added"; edge: Edge }
  | { type: "edge:removed"; id: string }
  | { type: "node:status"; id: string; status: NodeStatus; error?: string; lastRun?: RunInfo }
  | { type: "node:output"; id: string; output: Output }
  | { type: "viewport"; viewport: Graph["viewport"] };

export interface AddNodeArgs {
  type: NodeType;
  position?: { x: number; y: number };
  data?: Partial<{
    prompt: string;
    model: string;
    params: Record<string, unknown>;
  }>;
}

export interface ConnectArgs {
  source: string;
  sourceHandle: PortOut;
  target: string;
  targetHandle: PortIn;
}

export type RunResult =
  | { jobId: string }
  | {
      needConfirm: true;
      estimate: { amount: number; currency: string; note?: string; metered?: boolean };
    };

// Params the canvas itself owns rather than the model: node geometry, archive
// state, and the builtin nodes' own settings. These survive a model switch.
const UI_OWNED_PARAMS = new Set([
  "w",
  "h",
  "aspect",
  "color",
  "archived",
  "archivedReason",
  "time", // frame_extract
  "start", // video_trim
  "end", // video_trim
  "length", // av_mux
]);

// Ask before anything that costs real money at video/audio scale, and before
// anything whose price cannot be quoted up front (Pika meters several models
// per output token with no published token count — silently running one of
// those would spend an amount the user was never shown).
const CONFIRM_KINDS = new Set(["video", "audio"]);

const MAX_IMPORT_CHARS = 50000;

function decodeDataUrl(dataUrl: string): Buffer {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("invalid data url");
  return m[2]
    ? Buffer.from(m[3], "base64")
    : Buffer.from(decodeURIComponent(m[3]), "utf8");
}

// Extract readable text from a document buffer by file type.
async function extractText(buf: Buffer, filename: string): Promise<string> {
  const ext = (path.extname(filename).slice(1) || "").toLowerCase();
  let text: string;
  if (ext === "pdf") {
    text = (await pdfParse(buf)).text;
  } else if (ext === "html" || ext === "htm") {
    text = htmlToText(buf.toString("utf8"));
  } else {
    // txt, md, markdown, csv, json, log, and other text formats
    text = buf.toString("utf8");
  }
  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_IMPORT_CHARS);
}

// Lightweight HTML -> readable text for web_clip (no heavy deps).
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class Canvas extends EventEmitter {
  readonly projectId: string;
  private graph: Graph;
  private jobs = new Map<string, Job>();
  private cancelled = new Set<string>();

  constructor(projectId: string, graph?: Graph) {
    super();
    this.projectId = projectId;
    this.graph =
      graph ?? {
        id: projectId,
        name: "Untitled Space",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: new Date().toISOString(),
      };

    // ジョブはメモリ上にしか存在しない。前回終了時に running/queued だったノードは
    // もう走っていないので、起動時に解除する（放置すると永久に「実行中」に見える）。
    for (const n of this.graph.nodes) {
      if (n.status === "running" || n.status === "queued") {
        n.status = "failed";
        n.error = "アプリ終了により中断されました";
      }
      // video_concat had no model before Pika Video Merge joined it; an empty
      // id always meant the local ffmpeg concat, so say so explicitly.
      if (n.type === "video_concat" && !n.data.model) n.data.model = BUILTIN_CONCAT_MODEL;
    }
  }

  // ---- helpers ----

  private touch() {
    this.graph.updatedAt = new Date().toISOString();
    void saveProjectGraph(this.projectId, this.graph);
  }

  private emitEvent(ev: CanvasEvent) {
    this.emit("event", ev);
  }

  private node(id: string): GraphNode {
    const n = this.graph.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`node not found: ${id}`);
    return n;
  }

  // ---- reads ----

  getGraph(): Graph {
    return this.graph;
  }

  // Compact representation for agents (spec §5): small payload, enough to plan.
  getGraphCompact() {
    return {
      id: this.graph.id,
      name: this.graph.name,
      nodes: this.graph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        // 座標とサイズ。これが無いと整列・重なり判定ができない
        // （canvas_update_node は position を受け付けるので読み書き対称にする）。
        position: n.position,
        size: { w: n.data.params.w, h: n.data.params.h },
        prompt: n.data.prompt,
        model: n.data.model,
        status: n.status,
        hasOutput: n.data.outputs.length > 0,
        outputKinds: n.data.outputs.map((o) => o.kind),
        error: n.error,
      })),
      edges: this.graph.edges.map((e) => ({
        id: e.id,
        from: `${e.source}.${e.sourceHandle}`,
        to: `${e.target}.${e.targetHandle}`,
      })),
    };
  }

  listModels(): ModelSpec[] {
    return MODELS;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  // ---- structure ops (spec §2) ----

  addNode(args: AddNodeArgs): GraphNode {
    const type = args.type;
    if (!PORTS[type]) throw new Error(`invalid node type: ${type}`);
    const model = args.data?.model ?? defaultModelFor(type);
    const spec = model ? getModel(model) : undefined;
    const node: GraphNode = {
      id: nanoid(),
      type,
      position: args.position ?? { x: 80, y: 80 },
      data: {
        prompt: args.data?.prompt ?? "",
        model,
        params: { ...(spec?.defaults ?? {}), ...(args.data?.params ?? {}) },
        outputs: [],
      },
      status: "idle",
    };
    this.graph.nodes.push(node);
    this.touch();
    this.emitEvent({ type: "node:added", node });
    return node;
  }

  updateNode(
    id: string,
    patch: {
      position?: { x: number; y: number };
      data?: Partial<{
        prompt: string;
        model: string;
        params: Record<string, unknown>;
      }>;
    },
  ): GraphNode {
    const n = this.node(id);
    if (patch.position) n.position = patch.position;
    if (patch.data) {
      if (patch.data.prompt !== undefined) n.data.prompt = patch.data.prompt;
      if (patch.data.model !== undefined) {
        n.data.model = patch.data.model;
        const spec = getModel(patch.data.model);
        if (spec) {
          // Carry over only params the new model actually declares. Pika models
          // reuse key names with different enums (one model's "4k" resolution is
          // another's 422), so keeping every old key would fail the run over a
          // setting the user cannot even see on the new model.
          //
          // "" means "unset" — dropping it lets the new model's own default win
          // instead of a previous model's blank shadowing it.
          const allowed = new Set(spec.paramSchema.map((f) => f.key));
          const kept: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(n.data.params)) {
            const uiOwned = UI_OWNED_PARAMS.has(k);
            if (!uiOwned && (!allowed.has(k) || v === "")) continue;
            kept[k] = v;
          }
          n.data.params = { ...spec.defaults, ...kept };
        }
      }
      if (patch.data.params !== undefined)
        n.data.params = { ...n.data.params, ...patch.data.params };
    }
    this.touch();
    this.emitEvent({ type: "node:updated", node: n });
    return n;
  }

  deleteNode(id: string): void {
    const idx = this.graph.nodes.findIndex((x) => x.id === id);
    if (idx === -1) throw new Error(`node not found: ${id}`);
    // remove attached edges first
    const attached = this.graph.edges.filter(
      (e) => e.source === id || e.target === id,
    );
    for (const e of attached) this.disconnect(e.id);
    this.graph.nodes.splice(idx, 1);
    this.touch();
    this.emitEvent({ type: "node:deleted", id });
  }

  connect(args: ConnectArgs): Edge {
    const src = this.node(args.source);
    const dst = this.node(args.target);
    const check = connectionValid(
      src,
      args.sourceHandle,
      dst,
      args.targetHandle,
    );
    if (!check.ok) throw new Error(`invalid connection: ${check.reason}`);
    // Most input ports take a single source; reference ports accept many.
    if (!MULTI_INPUT_PORTS.has(args.targetHandle)) {
      const existing = this.graph.edges.find(
        (e) => e.target === args.target && e.targetHandle === args.targetHandle,
      );
      if (existing) this.disconnect(existing.id);
    }

    const edge: Edge = {
      id: nanoid(),
      source: args.source,
      sourceHandle: args.sourceHandle,
      target: args.target,
      targetHandle: args.targetHandle,
    };
    this.graph.edges.push(edge);
    this.touch();
    this.emitEvent({ type: "edge:added", edge });
    return edge;
  }

  disconnect(edgeId: string): void {
    const idx = this.graph.edges.findIndex((e) => e.id === edgeId);
    if (idx === -1) throw new Error(`edge not found: ${edgeId}`);
    this.graph.edges.splice(idx, 1);
    this.touch();
    this.emitEvent({ type: "edge:removed", id: edgeId });
  }

  /**
   * What this project actually cost, with metered work counted separately.
   * Summing `meta.cost` alone hides every token-billed generation, which for a
   * video project is usually the bulk of the spend.
   */
  costSummary(): {
    measuredUsd: number;
    measuredOutputs: number;
    meteredOutputs: number;
    byModel: { model: string; outputs: number; measuredUsd: number; metered: number }[];
  } {
    const by = new Map<string, { outputs: number; measuredUsd: number; metered: number }>();
    let measuredUsd = 0, measuredOutputs = 0, meteredOutputs = 0;
    for (const node of this.graph.nodes) {
      for (const o of node.data.outputs ?? []) {
        const model = o.meta.model ?? "unknown";
        const row = by.get(model) ?? { outputs: 0, measuredUsd: 0, metered: 0 };
        row.outputs += 1;
        if (o.meta.cost === null || o.meta.cost === undefined) {
          row.metered += 1;
          meteredOutputs += 1;
        } else {
          row.measuredUsd += o.meta.cost;
          measuredUsd += o.meta.cost;
          measuredOutputs += 1;
        }
        by.set(model, row);
      }
    }
    return {
      measuredUsd: Number(measuredUsd.toFixed(4)),
      measuredOutputs,
      meteredOutputs,
      byModel: [...by.entries()]
        .map(([model, r]) => ({ model, ...r, measuredUsd: Number(r.measuredUsd.toFixed(4)) }))
        .sort((a, b) => b.measuredUsd - a.measuredUsd || b.outputs - a.outputs),
    };
  }

  // ---- sugar ----

  setPrompt(id: string, text: string): GraphNode {
    return this.updateNode(id, { data: { prompt: text } });
  }
  setModel(id: string, model: string): GraphNode {
    return this.updateNode(id, { data: { model } });
  }
  setParams(id: string, patch: Record<string, unknown>): GraphNode {
    return this.updateNode(id, { data: { params: patch } });
  }

  setName(name: string): void {
    this.graph.name = name;
    this.touch();
  }

  setViewport(viewport: Graph["viewport"]): void {
    this.graph.viewport = viewport;
    this.touch();
    this.emitEvent({ type: "viewport", viewport });
  }

  // ---- inputs resolution (spec §1) ----

  // Text content of a node: a note's own content, else its latest text output.
  private textOf(src: GraphNode): string | undefined {
    if (src.type === "note" || src.type === "doc") return src.data.prompt;
    for (let i = src.data.outputs.length - 1; i >= 0; i--)
      if (src.data.outputs[i].kind === "text") return src.data.outputs[i].text;
    return undefined;
  }

  getText(id: string): { text: string } {
    return { text: this.textOf(this.node(id)) ?? "" };
  }

  /**
   * Edges into `node`, in the order their sources should be read. Clips on
   * clip_in play left to right by node position — the order the canvas shows
   * and the local concat has always used — so Pika Video Merge gets the same
   * order rather than the order the wires happened to be drawn in.
   */
  private incomingEdges(node: GraphNode): Edge[] {
    const incoming = this.graph.edges.filter((e) => e.target === node.id);
    const pos = (e: Edge) => this.graph.nodes.find((n) => n.id === e.source)?.position;
    const clips = incoming
      .filter((e) => e.targetHandle === "clip_in")
      .sort((a, b) => {
        const pa = pos(a), pb = pos(b);
        return (pa?.x ?? 0) - (pb?.x ?? 0) || (pa?.y ?? 0) - (pb?.y ?? 0);
      });
    return [...incoming.filter((e) => e.targetHandle !== "clip_in"), ...clips];
  }

  /**
   * What is wired into `node` right now, for the run record. Unlike
   * resolveInputs this never throws: the builtin nodes report a missing input
   * from inside their job, and the record should still say what was there.
   */
  private describeIncoming(node: GraphNode): RunRequest["inputs"] {
    const out: RunRequest["inputs"] = [];
    for (const e of this.incomingEdges(node)) {
      const src = this.graph.nodes.find((n) => n.id === e.source);
      const kind = inputKindOf(node.type, e.targetHandle);
      if (!src || !kind) continue;
      if (kind === "text") {
        const text = this.textOf(src);
        if (text) out.push({ port: e.targetHandle, kind, url: "", textChars: text.length });
        continue;
      }
      const o = [...src.data.outputs].reverse().find((x) => x.kind === kind);
      if (o) out.push({ port: e.targetHandle, kind, url: o.url });
    }
    return out;
  }

  private resolveInputs(node: GraphNode): ResolvedInput[] {
    const incoming = this.incomingEdges(node);
    const resolved: ResolvedInput[] = [];
    for (const e of incoming) {
      const src = this.graph.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      const targetKind = inputKindOf(node.type, e.targetHandle);
      if (targetKind === "text") {
        const text = this.textOf(src);
        if (text != null && text !== "")
          resolved.push({ port: e.targetHandle, kind: "text", url: "", text });
      } else {
        const out = src.data.outputs[src.data.outputs.length - 1];
        if (out) resolved.push({ port: e.targetHandle, kind: out.kind, url: out.url });
      }
    }
    // required input check
    const have = new Set(resolved.map((r) => r.port));
    for (const req of requiredInputs(node.type)) {
      if (!have.has(req))
        throw new Error(
          `required input "${req}" of node ${node.id} is unconnected or upstream has no output`,
        );
    }
    return resolved;
  }

  // ---- run (spec §2 run-guard) ----

  run(id: string, opts?: { confirm?: boolean }): RunResult {
    const node = this.node(id);
    if (node.type === "note" || node.type === "doc" || node.type === "frame")
      throw new Error(`${node.type} nodes don't run`);
    if (node.type === "web_clip") return this.runWebClip(node);
    // video_concat runs locally unless Pika Video Merge is selected on it.
    if (node.type === "video_concat" && !node.data.model.startsWith("pika/"))
      return this.runVideoConcat(node);
    if (node.type === "video_trim") return this.runVideoTrim(node);
    if (node.type === "frame_extract") return this.runFrameExtract(node);
    if (node.type === "av_mux") return this.runAvMux(node);

    const spec = getModel(node.data.model);
    if (!spec) {
      // Pika retires endpoints (deepseek-v4-flash, eleven-music sfx in 2026-09),
      // and a saved node keeps naming the one it was built with.
      throw new Error(
        node.data.model
          ? `モデル「${node.data.model}」は現在の Pika カタログにありません（提供終了または名称変更）。` +
              "ノードの「設定」から別のモデルを選んでください。"
          : `ノード ${id} にモデルが選ばれていません。「設定」からモデルを選んでください。`,
      );
    }
    const adapter = adapterFor(node.data.model);

    const resolved = this.resolveInputs(node); // throws on missing required input
    // A connected text input drives the prompt; only media goes to the adapter.
    // LLM nodes are the exception — they read upstream text as reference
    // material rather than as their instruction, so they keep the full set.
    const textIn = resolved.find((r) => r.kind === "text" && r.text && r.text.trim());
    const mediaInputs =
      node.type === "llm_text" ? resolved : resolved.filter((r) => r.kind !== "text");
    const effPrompt = node.type === "llm_text" ? node.data.prompt : (textIn?.text ?? node.data.prompt);
    const estimate = adapter.estimateCost(
      node.data.model,
      node.data.params,
      mediaInputs,
      effPrompt,
    );

    // Unquotable models (amount 0 with an explanatory note) also need a
    // confirm — "$0" must never be mistaken for "free".
    const unquotable = estimate.amount === 0 && !!estimate.note;
    const needsConfirm = CONFIRM_KINDS.has(spec.kind) || unquotable;
    if (needsConfirm && !opts?.confirm) {
      return {
        needConfirm: true,
        estimate: {
          amount: estimate.amount,
          currency: estimate.currency,
          note: estimate.note,
          metered: estimate.metered,
        },
      };
    }

    // Freeze what this run uses. The inspector stays editable while the job
    // runs (a video job can take an hour), so the job must not read the node
    // again — an edit made meanwhile belongs to the next run.
    const params = { ...node.data.params };
    const request: RunRequest = {
      model: node.data.model,
      prompt: effPrompt,
      promptSource: node.type !== "llm_text" && textIn ? "text_in" : "node",
      params: this.paramsSent(spec, params),
      inputs: this.describeIncoming(node),
    };
    const job = this.beginJob(node, request, estimate);

    // dispatch async
    void this.execute(job, node, mediaInputs, params, request);
    return { jobId: job.id };
  }

  /** The model params a run actually carries: declared by the model and set. */
  private paramsSent(spec: ModelSpec, params: Record<string, unknown>): Record<string, unknown> {
    const declared = new Set(spec.paramSchema.map((f) => f.key));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      // "" means "leave it to the model" and is never sent.
      if (declared.has(k) && v !== "" && v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  /** Builtin nodes keep their settings among the UI-owned params; pick them out by name. */
  private builtinRequest(node: GraphNode, keys: string[]): RunRequest {
    const params: Record<string, unknown> = {};
    for (const k of keys) {
      const v = node.data.params[k];
      if (v !== "" && v !== undefined && v !== null) params[k] = v;
    }
    return {
      model: node.data.model || `builtin/${node.type}`,
      prompt: "",
      promptSource: "node",
      params,
      inputs: this.describeIncoming(node),
    };
  }

  /**
   * Register a job and record on the node what it is about to run on, so the
   * inspector can show the prompt and settings while the job is still going.
   */
  private beginJob(node: GraphNode, request: RunRequest, estimate?: CostEstimate): Job {
    const job: Job = {
      id: nanoid(),
      nodeId: node.id,
      status: "queued",
      progress: 0,
      estimate,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    node.lastRun = { ...request, jobId: job.id, startedAt: job.createdAt, estimate };
    this.setStatus(node, "queued");
    return job;
  }

  // ノードから実行中ジョブを引いて止める。UI は jobId を保持しないので、
  // 「このノードを止める」を成立させるための入り口。
  cancelNode(nodeId: string): { cancelled: boolean } {
    for (const [jobId, job] of this.jobs) {
      if (job.nodeId !== nodeId) continue;
      if (job.status === "succeeded" || job.status === "failed") continue;
      this.cancel(jobId);
      return { cancelled: true };
    }
    // 対応するジョブが無いのに running のまま＝アプリ再起動をまたいだ残骸。
    // ジョブはメモリ上にしか無いため、ここで解除しないと永久に「実行中」に見える。
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (node && (node.status === "running" || node.status === "queued")) {
      this.setStatus(node, "failed", "中断されました（アプリ再起動で実行が失われた可能性があります）");
      this.touch();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status === "succeeded" || job.status === "failed") return;
    this.cancelled.add(jobId);
    job.status = "failed";
    job.error = "cancelled";
    const node = this.graph.nodes.find((n) => n.id === job.nodeId);
    if (node) this.setStatus(node, "failed", "cancelled");
  }

  // ---- web_clip (builtin: fetch a URL -> readable text) ----
  private runWebClip(node: GraphNode): RunResult {
    const job = this.beginJob(node, this.builtinRequest(node, ["url", "maxChars"]));
    void this.executeWebClip(job, node);
    return { jobId: job.id };
  }

  private async executeWebClip(job: Job, node: GraphNode): Promise<void> {
    try {
      job.status = "running";
      this.setStatus(node, "running");
      const url = String(node.data.params.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) throw new Error("有効な http(s) URL を入力してください");
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (CreativeCanvas web_clip)" },
      });
      if (!res.ok) throw new Error(`fetch failed ${res.status}`);
      const html = await res.text();
      const max = Number(node.data.params.maxChars ?? 12000);
      const text = htmlToText(html).slice(0, max);
      const output: Output = {
        id: nanoid(),
        kind: "text",
        url: "",
        text,
        meta: { provider: "web", model: "web_clip" },
        createdAt: new Date().toISOString(),
      };
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });
      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = msg;
      this.setStatus(node, "failed", msg);
    }
  }

  // ---- video_concat (builtin: join clips A->B->… with ffmpeg) ----
  private runVideoConcat(node: GraphNode): RunResult {
    const job = this.beginJob(node, this.builtinRequest(node, []));
    void this.executeConcat(job, node);
    return { jobId: job.id };
  }

  private async executeConcat(job: Job, node: GraphNode): Promise<void> {
    try {
      job.status = "running";
      this.setStatus(node, "running");
      // Gather connected clips, ordered left-to-right by source node position.
      const clips = this.graph.edges
        .filter((e) => e.target === node.id && e.targetHandle === "clip_in")
        .map((e) => {
          const src = this.graph.nodes.find((n) => n.id === e.source);
          const out = [...(src?.data.outputs ?? [])]
            .reverse()
            .find((o) => o.kind === "video");
          return src && out ? { x: src.position.x, y: src.position.y, url: out.url } : null;
        })
        .filter((c): c is { x: number; y: number; url: string } => !!c)
        .sort((a, b) => a.x - b.x || a.y - b.y);

      if (clips.length < 2)
        throw new Error("clip_in に2本以上の動画を接続してください（左→右の順で連結）");

      const inputs = clips.map((c) => resolveAssetPath(c.url));
      const name = `${nanoid()}.mp4`;
      await fs.mkdir(projectAssetsDir(this.projectId), { recursive: true });
      const outPath = path.join(projectAssetsDir(this.projectId), name);
      await concatVideos(inputs, outPath);

      const output: Output = {
        id: nanoid(),
        kind: "video",
        url: `/assets/${this.projectId}/${name}`,
        meta: { provider: "ffmpeg", model: "video_concat" },
        createdAt: new Date().toISOString(),
      };
      this.archiveSupersededOutput(node);
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });
      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = msg;
      this.setStatus(node, "failed", msg);
    }
  }

  // ---- frame_extract (builtin: grab one frame from a video at a chosen time) ----
  private runVideoTrim(node: GraphNode): RunResult {
    const job = this.beginJob(node, this.builtinRequest(node, ["start", "end"]));
    void this.executeVideoTrim(job, node);
    return { jobId: job.id };
  }

  /** The single video connected to `video_in`, with its latest video output. */
  private connectedVideo(node: GraphNode): { url: string } {
    const edge = this.graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === "video_in",
    );
    const src = edge && this.graph.nodes.find((n) => n.id === edge.source);
    const vid =
      src && [...(src.data.outputs ?? [])].reverse().find((o) => o.kind === "video");
    if (!vid) throw new Error("video_in に動画出力を持つノードを接続してください");
    return vid;
  }

  private async executeVideoTrim(job: Job, node: GraphNode): Promise<void> {
    try {
      job.status = "running";
      this.setStatus(node, "running");

      const vid = this.connectedVideo(node);
      const inputPath = resolveAssetPath(vid.url);
      const duration = await probeDuration(inputPath);
      // Same time spec as frame_extract: seconds, "first"/"last", or "NN%".
      const start = this.frameTimeSec(node.data.params.start ?? 0, duration);
      const endRaw = node.data.params.end;
      const end =
        endRaw === undefined || endRaw === "" || endRaw === "last" || endRaw === "end"
          ? duration
          : this.frameTimeSec(endRaw, duration);
      if (!(end > start))
        throw new Error(`トリム範囲が不正です: start=${start}s end=${end}s（尺 ${duration.toFixed(2)}s）`);

      const name = `${nanoid()}.mp4`;
      await fs.mkdir(projectAssetsDir(this.projectId), { recursive: true });
      const outPath = path.join(projectAssetsDir(this.projectId), name);
      await trimVideo(inputPath, start, end, outPath);

      const output: Output = {
        id: nanoid(),
        kind: "video",
        url: `/assets/${this.projectId}/${name}`,
        meta: {
          provider: "ffmpeg",
          model: "video_trim",
          durationSec: Number((end - start).toFixed(3)),
          cost: 0, // local ffmpeg: genuinely free, unlike a metered model
        },
        createdAt: new Date().toISOString(),
      };
      this.archiveSupersededOutput(node);
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });

      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
      this.setStatus(node, "failed", job.error);
    }
  }

  private runFrameExtract(node: GraphNode): RunResult {
    const job = this.beginJob(node, this.builtinRequest(node, ["time"]));
    void this.executeFrameExtract(job, node);
    return { jobId: job.id };
  }

  // Resolve a time spec (number seconds | "first" | "last" | "NN%") to seconds.
  private frameTimeSec(raw: unknown, duration: number): number {
    if (typeof raw === "number") return Math.max(0, raw);
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "" || s === "first") return 0;
    if (s === "last" || s === "end") return Math.max(0, duration - 0.05);
    if (s.endsWith("%")) {
      const pct = Number(s.slice(0, -1));
      if (Number.isFinite(pct))
        return Math.max(0, Math.min(duration, (pct / 100) * duration));
    }
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  private async executeFrameExtract(job: Job, node: GraphNode): Promise<void> {
    try {
      job.status = "running";
      this.setStatus(node, "running");
      // single connected video on video_in -> its latest video output
      const edge = this.graph.edges.find(
        (e) => e.target === node.id && e.targetHandle === "video_in",
      );
      const src = edge && this.graph.nodes.find((n) => n.id === edge.source);
      const vid =
        src && [...(src.data.outputs ?? [])].reverse().find((o) => o.kind === "video");
      if (!vid) throw new Error("video_in に動画出力を持つノードを接続してください");

      const inputPath = resolveAssetPath(vid.url);
      const duration = await probeDuration(inputPath);
      const t = this.frameTimeSec(node.data.params.time, duration);

      const name = `${nanoid()}.png`;
      await fs.mkdir(projectAssetsDir(this.projectId), { recursive: true });
      const outPath = path.join(projectAssetsDir(this.projectId), name);
      await extractFrame(inputPath, t, outPath);

      const output: Output = {
        id: nanoid(),
        kind: "image",
        url: `/assets/${this.projectId}/${name}`,
        meta: { provider: "ffmpeg", model: "frame_extract" },
        createdAt: new Date().toISOString(),
      };
      this.archiveSupersededOutput(node);
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });
      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = msg;
      this.setStatus(node, "failed", msg);
    }
  }

  // ---- av_mux (builtin: put an audio track onto a video with ffmpeg) ----
  private runAvMux(node: GraphNode): RunResult {
    const job = this.beginJob(node, this.builtinRequest(node, ["length"]));
    void this.executeAvMux(job, node);
    return { jobId: job.id };
  }

  /** Latest output of the given kind on whatever is wired to `port`. */
  private latestOn(node: GraphNode, port: PortIn, kind: Output["kind"]): Output | undefined {
    const edge = this.graph.edges.find((e) => e.target === node.id && e.targetHandle === port);
    const src = edge && this.graph.nodes.find((n) => n.id === edge.source);
    return src ? [...(src.data.outputs ?? [])].reverse().find((o) => o.kind === kind) : undefined;
  }

  private async executeAvMux(job: Job, node: GraphNode): Promise<void> {
    try {
      job.status = "running";
      this.setStatus(node, "running");

      const vid = this.latestOn(node, "video_in", "video");
      const aud = this.latestOn(node, "audio_in", "audio");
      if (!vid) throw new Error("video_in に動画出力を持つノードを接続してください");
      if (!aud) throw new Error("audio_in に音声出力を持つノードを接続してください");

      const videoPath = resolveAssetPath(vid.url);
      const audioPath = resolveAssetPath(aud.url);
      const mode = String(node.data.params.length ?? "video") === "shortest" ? "shortest" : "video";

      const name = `${nanoid()}.mp4`;
      await fs.mkdir(projectAssetsDir(this.projectId), { recursive: true });
      const outPath = path.join(projectAssetsDir(this.projectId), name);
      await muxAudio(videoPath, audioPath, outPath, mode);

      const output: Output = {
        id: nanoid(),
        kind: "video",
        url: `/assets/${this.projectId}/${name}`,
        meta: { provider: "ffmpeg", model: "av_mux" },
        createdAt: new Date().toISOString(),
      };
      this.archiveSupersededOutput(node);
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });
      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = msg;
      this.setStatus(node, "failed", msg);
    }
  }

  private setStatus(node: GraphNode, status: NodeStatus, error?: string) {
    node.status = status;
    node.error = error;
    if ((status === "succeeded" || status === "failed") && node.lastRun && !node.lastRun.finishedAt)
      node.lastRun.finishedAt = new Date().toISOString();
    this.touch();
    this.emitEvent({ type: "node:status", id: node.id, status, error, lastRun: node.lastRun });
  }

  // When a media node re-generates, the output it currently shows would otherwise
  // be buried behind the new one (the UI only renders outputs[last]) — to the user
  // it just "disappears". Instead, spin that prior output off into its own archived
  // sibling node so nothing is lost: it shows up in the Archive panel and can be
  // restored. Call BEFORE recording a run's new output(s). No-op on first
  // generation (no prior output) or for text outputs.
  //
  // `params.archived` is the very flag the web UI uses to move a node into the
  // Archive, so this works identically for UI- and agent-driven runs (the ops API
  // stays the single contract — no UI-only path).
  private archiveSupersededOutput(node: GraphNode): void {
    const prev = node.data.outputs[node.data.outputs.length - 1];
    if (!prev || prev.kind === "text") return;
    // The node's settings have usually moved on since `prev` was made — that is
    // why it is being re-run. The archived copy should carry what made `prev`,
    // which the output remembers (outputs from before it did fall back).
    const req = prev.meta.request;
    const uiOwned = Object.fromEntries(
      Object.entries(node.data.params).filter(([k]) => UI_OWNED_PARAMS.has(k)),
    );
    const snapshot: GraphNode = {
      id: nanoid(),
      type: node.type,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
      data: {
        prompt: req && req.promptSource === "node" ? req.prompt : node.data.prompt,
        model: req?.model ?? node.data.model,
        params: {
          ...(req ? { ...uiOwned, ...req.params } : node.data.params),
          archived: true,
          archivedReason: "superseded",
        },
        outputs: [{ ...prev, id: nanoid() }],
      },
      status: "succeeded",
    };
    this.graph.nodes.push(snapshot);
    this.touch();
    this.emitEvent({ type: "node:added", node: snapshot });
  }

  private async execute(
    job: Job,
    node: GraphNode,
    inputs: ResolvedInput[],
    params: Record<string, unknown>,
    request: RunRequest,
  ): Promise<void> {
    // Everything below reads the frozen request, never node.data: the user may
    // switch the node's model mid-run, and the output must still be filed under
    // the model that actually made it.
    const model = request.model;
    const adapter = adapterFor(model);
    try {
      job.status = "running";
      this.setStatus(node, "running");

      const result = await adapter.run(model, {
        prompt: request.prompt,
        params,
        inputs,
        onSubmitted: (providerJobId) => {
          if (node.lastRun?.jobId !== job.id) return; // a newer run has taken over
          node.lastRun.providerJobId = providerJobId;
          this.touch();
          this.emitEvent({
            type: "node:status",
            id: node.id,
            status: node.status,
            error: node.error,
            lastRun: node.lastRun,
          });
        },
      });

      if (this.cancelled.has(job.id)) {
        this.cancelled.delete(job.id);
        return;
      }

      // Preserve the prior result before this run's output replaces it on screen.
      if (result.outputs.length > 0) this.archiveSupersededOutput(node);

      for (const raw of result.outputs) {
        // Text results (LLM answers, transcripts) arrive inline — there is
        // nothing to download, and they live in the output's `text` field the
        // same way web_clip's do.
        const localUrl =
          raw.kind === "text" && raw.text !== undefined
            ? ""
            : (await downloadToAssets(raw.url, raw.kind, this.projectId, raw.fetchHeaders)).localUrl;
        const output: Output = {
          id: nanoid(),
          kind: raw.kind,
          url: localUrl,
          text: raw.text,
          meta: {
            width: raw.width,
            height: raw.height,
            durationSec: raw.durationSec,
            provider: adapter.id,
            model,
            cost: result.cost,
            usage: result.usage,
            seed: raw.seed,
            request,
            providerJobId: result.providerJobId,
          },
          createdAt: new Date().toISOString(),
        };
        node.data.outputs.push(output);
        this.touch();
        this.emitEvent({ type: "node:output", id: node.id, output });
      }

      job.status = "succeeded";
      job.progress = 1;
      this.setStatus(node, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = msg;
      this.setStatus(node, "failed", msg);
    }
  }

  // ---- assets (spec §2 uploadImage) ----

  /**
   * Accept either a data: URL (browser drop) or a local filesystem path (agents
   * and the MCP). The two upload surfaces used to disagree — project-level took
   * a path, node-level took a dataUrl — and passing the wrong one surfaced as a
   * raw `undefined.startsWith` TypeError rather than a usable message.
   */
  private async ingest(
    source: unknown,
    kind: "image" | "video" | "audio",
    field: string,
  ): Promise<string> {
    if (typeof source !== "string" || !source.trim())
      throw new Error(
        `${field}: expected a data: URL or a local file path, received ${source === undefined ? "nothing" : typeof source}`,
      );
    const src = source.trim();
    if (src.startsWith("data:") || /^https?:\/\//.test(src))
      return (await downloadToAssets(src, kind, this.projectId)).localUrl;
    const abs = path.resolve(src);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      throw new Error(`${field}: cannot read file ${abs}`);
    }
    const fallback = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
    const ext = (path.extname(abs).slice(1) || fallback).toLowerCase();
    return saveBytesToAssets(bytes, ext, this.projectId);
  }

  async uploadImage(filePath: string): Promise<{ node: GraphNode; output: Output }> {
    const abs = path.resolve(filePath);
    const bytes = await fs.readFile(abs);
    const ext = (path.extname(abs).slice(1) || "png").toLowerCase();
    const localUrl = await saveBytesToAssets(bytes, ext, this.projectId);
    const node = this.addNode({
      type: "image_gen",
      data: { prompt: `(uploaded: ${path.basename(abs)})` },
    });
    const output: Output = {
      id: nanoid(),
      kind: "image",
      url: localUrl,
      meta: { provider: "upload", model: "upload" },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.setStatus(node, "succeeded");
    this.emitEvent({ type: "node:output", id: node.id, output });
    return { node, output };
  }

  // Attach an uploaded image to an existing node. Accepts a data: URL or a path.
  async uploadToNode(id: string, source: string): Promise<Output> {
    const node = this.node(id);
    const localUrl = await this.ingest(source, "image", "dataUrl");
    const output: Output = {
      id: nanoid(),
      kind: "image",
      url: localUrl,
      meta: { provider: "upload", model: "upload" },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.touch();
    this.emitEvent({ type: "node:output", id: node.id, output });
    this.setStatus(node, "succeeded");
    return output;
  }

  // Attach an uploaded video to an existing node. Accepts a data: URL or a path.
  async uploadVideoToNode(id: string, source: string): Promise<Output> {
    return this.attachVideoToNode(id, await this.ingest(source, "video", "dataUrl"));
  }

  // Attach a video already saved into the project's assets dir (e.g. a streamed
  // raw upload) to an existing node.
  attachVideoToNode(id: string, localUrl: string): Output {
    const node = this.node(id);
    const output: Output = {
      id: nanoid(),
      kind: "video",
      url: localUrl,
      meta: { provider: "upload", model: "upload" },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.touch();
    this.emitEvent({ type: "node:output", id: node.id, output });
    this.setStatus(node, "succeeded");
    return output;
  }

  // Attach a browser-uploaded audio clip (data: URL) to an existing node.
  async uploadAudioToNode(id: string, source: string): Promise<Output> {
    return this.attachAudioToNode(id, await this.ingest(source, "audio", "dataUrl"));
  }

  // Attach an audio clip already saved into the project's assets dir (e.g. a
  // streamed raw upload) to an existing node.
  attachAudioToNode(id: string, localUrl: string): Output {
    const node = this.node(id);
    const output: Output = {
      id: nanoid(),
      kind: "audio",
      url: localUrl,
      meta: { provider: "upload", model: "upload" },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.touch();
    this.emitEvent({ type: "node:output", id: node.id, output });
    this.setStatus(node, "succeeded");
    return output;
  }

  // Upload a local audio file by path (used by the MCP agent): creates an
  // audio_upload node holding it.
  async uploadAudio(filePath: string): Promise<{ node: GraphNode; output: Output }> {
    const abs = path.resolve(filePath);
    const bytes = await fs.readFile(abs);
    const ext = (path.extname(abs).slice(1) || "mp3").toLowerCase();
    const localUrl = await saveBytesToAssets(bytes, ext, this.projectId);
    const node = this.addNode({
      type: "audio_upload",
      data: { prompt: `(uploaded: ${path.basename(abs)})` },
    });
    const output: Output = {
      id: nanoid(),
      kind: "audio",
      url: localUrl,
      meta: { provider: "upload", model: "upload" },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.setStatus(node, "succeeded");
    this.emitEvent({ type: "node:output", id: node.id, output });
    return { node, output };
  }

  // Import a browser-uploaded document (data: URL) into a node as text.
  async importFileToNode(id: string, dataUrl: string, filename: string): Promise<Output> {
    const node = this.node(id);
    this.setStatus(node, "running");
    try {
      const text = await extractText(decodeDataUrl(dataUrl), filename || "file");
      const output: Output = {
        id: nanoid(),
        kind: "text",
        url: "",
        text,
        meta: { provider: "file", model: filename || "file_import" },
        createdAt: new Date().toISOString(),
      };
      node.data.outputs.push(output);
      this.touch();
      this.emitEvent({ type: "node:output", id: node.id, output });
      this.setStatus(node, "succeeded");
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(node, "failed", msg);
      throw err;
    }
  }

  // Import a local file by path (used by the MCP agent): creates a file_import node.
  async importFileFromPath(
    filePath: string,
  ): Promise<{ node: GraphNode; output: Output }> {
    const abs = path.resolve(filePath);
    const buf = await fs.readFile(abs);
    const base = path.basename(abs);
    const node = this.addNode({ type: "file_import", data: { prompt: base } });
    const text = await extractText(buf, base);
    const output: Output = {
      id: nanoid(),
      kind: "text",
      url: "",
      text,
      meta: { provider: "file", model: base },
      createdAt: new Date().toISOString(),
    };
    node.data.outputs.push(output);
    this.touch();
    this.emitEvent({ type: "node:output", id: node.id, output });
    this.setStatus(node, "succeeded");
    return { node, output };
  }
}
