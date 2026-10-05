import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode, OutputKind } from "./types";
import { PORTS } from "./ports";
import { labelOf, labelOfPort } from "./labels";
import { useStore, archiveNode } from "./store";
import { api } from "./api";
import { NodeInspector } from "./NodeInspector";
import { useDismissibleLayer } from "./useDismissibleLayer";
import { fmtElapsed, useNow } from "./RunDetails";

const STATUS_COLOR: Record<string, string> = {
  idle: "#6b7280",
  queued: "#d97706",
  running: "#2563eb",
  succeeded: "#16a34a",
  failed: "#dc2626",
};
const KIND_COLOR: Record<OutputKind, string> = {
  image: "#a855f7",
  video: "#0ea5e9",
  audio: "#eab308",
  text: "#22c55e",
};
const isVideoUrl = (url: string) => /\.(mp4|webm|mov)$/i.test(url);
const shortModel = (m: string) => m.replace(/^.*\//, "");

export function CanvasNode({ data, selected }: NodeProps) {
  const node = (data as { node: GraphNode }).node;
  const models = useStore((s) => s.models);
  const def = PORTS[node.type];
  const usable = useMemo(
    () => models.filter((model) => model.nodeTypes.includes(node.type)),
    [models, node.type],
  );
  const spec = useMemo(
    () => models.find((model) => model.id === node.data.model),
    [models, node.data.model],
  );

  const isUpload = node.type === "image_upload";
  const isVideoUpload = node.type === "video_upload";
  const isAudioUpload = node.type === "audio_upload";
  const isFileImport = node.type === "file_import";
  const isConcat = node.type === "video_concat";
  const isNote = node.type === "note";
  const isDoc = node.type === "doc";
  const isFrame = node.type === "frame";
  const isFrameExtract = node.type === "frame_extract";
  const isText = isNote || isDoc;
  const hasPrompt =
    node.type === "image_gen" ||
    node.type === "image_edit" ||
    node.type === "video_gen" ||
    node.type === "audio_gen" || // TTS の本文・SE/音楽の指示
    node.type === "video_to_audio" || // 劇伴の曲調指示
    node.type === "llm_text"; // LLM への指示文
  const hasModel = usable.length > 0;
  const hasParams = !!spec && spec.paramSchema.length > 0;
  const hasRun = !isUpload && !isVideoUpload && !isAudioUpload && !isFileImport && !isText && !isFrame;

  const [prompt, setPrompt] = useState(node.data.prompt);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setPrompt(node.data.prompt);
  }, [node.data.prompt]);
  const [busy, setBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [copied, setCopied] = useState(false);
  const inspectorButtonRef = useRef<HTMLButtonElement>(null);
  const lightboxRef = useDismissibleLayer<HTMLDivElement>(
    lightbox,
    () => setLightbox(false),
  );

  const out = node.data.outputs[node.data.outputs.length - 1];
  // image/video can be expanded in a lightbox; audio/text cannot.
  const mediaOut = out && (out.kind === "image" || out.kind === "video") ? out : undefined;
  // real generation state comes from the node status (live via WS), not the
  // brief local HTTP "busy" flag.
  const generating = node.status === "running" || node.status === "queued";
  const blocked = busy || generating;
  const now = useNow(generating);
  const elapsed =
    generating && node.lastRun ? fmtElapsed(now - Date.parse(node.lastRun.startedAt)) : "";
  // A saved node can name a model Pika has since retired.
  const retired = hasModel && !!node.data.model && !spec;

  function saveContent() {
    focused.current = false;
    if (prompt !== node.data.prompt)
      api.updateNode(node.id, { data: { prompt } }).catch(() => {});
  }
  async function onRun() {
    setInspectorOpen(false);
    setBusy(true);
    try {
      const res = await api.run(node.id, false);
      if ("needConfirm" in res) {
        const e = res.estimate;
        // A metered model has amount 0 only because the unit cannot be quoted.
        // Printing "約 $0" there asked the user to approve paid work as if it
        // were free, which is the opposite of what this dialog is for.
        const head = e.metered
          ? "課金されますが、事前に金額を出せません"
          : `見積り: 約 $${e.amount}`;
        if (window.confirm(`${head}\n${e.note ?? ""}\n\n実行しますか？`))
          await api.run(node.id, true);
      }
    } catch (err) {
      alert(`run failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  function pick(kind: "image" | "video" | "audio" | "doc") {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setBusy(true);
      if (kind === "video" || kind === "audio") {
        // Stream raw bytes; media files are large and base64 would exceed limits.
        const upload =
          kind === "video" ? api.uploadVideoFileRaw : api.uploadAudioFileRaw;
        upload(node.id, file)
          .catch((err) => alert((err as Error).message))
          .finally(() => setBusy(false));
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          if (kind === "image") await api.uploadFile(node.id, String(reader.result));
          else await api.importFile(node.id, String(reader.result), file.name);
        } catch (err) {
          alert((err as Error).message);
        } finally {
          setBusy(false);
        }
      };
      reader.readAsDataURL(file);
    };
  }
  function onMediaLoad(w: number, h: number) {
    if (!w || !h) return;
    const a = Number((w / h).toFixed(4));
    const cur = Number(node.data.params.aspect ?? 0);
    if (Math.abs(cur - a) > 0.02)
      api.updateNode(node.id, { data: { params: { aspect: a } } }).catch(() => {});
  }
  function download() {
    if (!out) return;
    const a = document.createElement("a");
    if (out.kind === "text") {
      const blob = new Blob([out.text ?? ""], { type: "text/plain" });
      a.href = URL.createObjectURL(blob);
      a.download = `${node.type}.txt`;
    } else {
      a.href = out.url;
      a.download = out.url.split("/").pop() || "output";
    }
    a.click();
  }
  function copyId() {
    const write = navigator.clipboard?.writeText(node.id);
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    if (write) write.then(done).catch(() => {
      // fallback for non-secure contexts
      try {
        const ta = document.createElement("textarea");
        ta.value = node.id; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch { /* ignore */ }
    });
    else done();
  }

  // ---- frame (layout organizer) ----
  if (isFrame) {
    const color = String(node.data.params.color ?? "slate");
    return (
      <div className={`frame-node frame-${color}`}>
        <NodeResizer
          isVisible={selected}
          minWidth={180}
          minHeight={120}
          onResizeEnd={(_e, p) =>
            api.updateNode(node.id, { position: { x: p.x, y: p.y }, data: { params: { w: p.width, h: p.height } } }).catch(() => {})
          }
        />
        <div className="frame-head nodrag">
          <input className="frame-title" value={prompt} placeholder="グループ名"
            onFocus={() => (focused.current = true)} onBlur={saveContent} onChange={(e) => setPrompt(e.target.value)} />
          <select className="frame-color" value={color}
            onChange={(e) => api.updateNode(node.id, { data: { params: { color: e.target.value } } }).catch(() => {})}>
            {["slate", "violet", "sky", "emerald", "amber", "rose"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
    );
  }

  const keepAR = !isText && !!node.data.params.aspect;
  const placeholder = isConcat
    ? "clip_in に動画を複数接続 → Run で連結"
    : isUpload ? "下のボタンから画像を選択"
    : isVideoUpload ? "ドラッグ&ドロップ、または下のボタンから動画を選択"
    : isAudioUpload ? "ドラッグ&ドロップ、または下のボタンからオーディオを選択"
    : isFileImport ? "下のボタンからファイルを取込"
    : node.type === "llm_text" ? "指示（プロンプト）を書いて Run"
    : "Run で生成";

  const floatBar = selected && !inspectorOpen && (
    <div className="cn-floatbar nodrag">
      <button className="cn-fb cn-fb-id" aria-label={`アセットID ${node.id} をコピー`} onClick={copyId}>
        {copied ? "✓ コピーしました" : `ID: ${node.id}`}
      </button>
      {hasRun && <button className="cn-fb" aria-label={generating ? "生成中" : node.data.outputs.length ? "再実行" : "実行"} onClick={() => void onRun()} disabled={blocked}>{generating ? "⏳" : node.data.outputs.length ? "↻" : "▶"}</button>}
      {mediaOut && <button className="cn-fb" aria-label="プレビューを拡大" onClick={() => setLightbox(true)}>⤢</button>}
      {out && <button className="cn-fb" aria-label="出力をダウンロード" onClick={download}>⬇</button>}
      <button className="cn-fb" aria-label="アーカイブへ移動（後で復元できます）" onClick={() => archiveNode(node.id)}>📥</button>
    </div>
  );

  const handles = (
    <>
      {def.inputs.map((inp, i) => (
        <Handle key={inp.port} id={inp.port} type="target" position={Position.Left}
          title={`${labelOfPort(inp.port)}${inp.required ? "（必須）" : ""} · ${inp.port}`}
          style={{ top: 34 + i * 20, background: KIND_COLOR[inp.kind], border: inp.required ? "2px solid #fff" : "1px solid #fff" }}>
          <span className="port-label port-in">{labelOfPort(inp.port)}{inp.required ? " *" : ""}</span>
        </Handle>
      ))}
      {def.output && (
        <Handle id={def.output.port} type="source" position={Position.Right}
          title={`${labelOfPort(def.output.port)} · ${def.output.port}`}
          style={{ top: 34, background: KIND_COLOR[def.output.kind] }}>
          <span className="port-label port-out">{labelOfPort(def.output.port)}</span>
        </Handle>
      )}
    </>
  );

  const resizer = (
    <NodeResizer
      isVisible={selected}
      minWidth={180}
      minHeight={140}
      keepAspectRatio={keepAR}
      onResizeEnd={(_e, p) =>
        api.updateNode(node.id, { position: { x: p.x, y: p.y }, data: { params: { w: p.width, h: p.height } } }).catch(() => {})
      }
    />
  );

  // ---- frame_extract: scrub an input video and grab one frame ----
  if (isFrameExtract) {
    return (
      <>
        {resizer}
        {floatBar}
        {handles}
        <div className="cn cn-frame_extract">
          <FrameExtractBody node={node} blocked={blocked} generating={generating} onRun={() => void onRun()} />
          <div className="cn-chip-type">{labelOf(node.type)}</div>
          <span className="cn-status-dot" style={{ background: STATUS_COLOR[node.status] }} title={node.error || node.status} />
        </div>
        {lightbox && mediaOut && createPortal(
          <div className="cn-lightbox" onClick={() => setLightbox(false)}>
            <div ref={lightboxRef} className="cn-lightbox-content" role="dialog" aria-modal="true" aria-label="出力プレビュー" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
              <button className="cn-lightbox-close" onClick={() => setLightbox(false)} aria-label="プレビューを閉じる">×</button>
              {isVideoUrl(mediaOut.url) ? <video src={mediaOut.url} controls autoPlay loop /> : <img src={mediaOut.url} alt="生成結果" />}
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }

  // ---- text nodes (note / doc): editor fills the node ----
  if (isText) {
    return (
      <>
        {resizer}
        {floatBar}
        {handles}
        <div className={`cn cn-${node.type}`}>
          <div className="cn-tophdr">{labelOf(node.type)}</div>
          <textarea className="nodrag cn-textarea"
            placeholder={isDoc ? "ドキュメント本文（台本・記事など）" : "メモ / 内容"}
            value={prompt} onFocus={() => (focused.current = true)} onBlur={saveContent}
            onChange={(e) => setPrompt(e.target.value)} />
        </div>
      </>
    );
  }

  // ---- media / generation nodes: content-first with overlaid icon controls ----
  return (
    <>
      {resizer}
      {floatBar}
      {handles}
      <div className={`cn cn-${node.type}`}>
        <div className="cn-body">
          {out ? (
            out.kind === "text" ? (
              <pre className="cn-text">{out.text}</pre>
            ) : out.kind === "audio" ? (
              <audio src={out.url} controls className="cn-audio" />
            ) : isVideoUrl(out.url) ? (
              <video src={out.url} controls loop muted className="cn-media"
                onLoadedMetadata={(e) => onMediaLoad(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
            ) : (
              <>
                <img src={out.url} alt="output" className="cn-media"
                  onLoad={(e) => onMediaLoad(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
                {out.kind === "video" && <span className="mock-badge">mock video</span>}
              </>
            )
          ) : (
            <div className="cn-empty">{placeholder}</div>
          )}
          {generating && (
            <div className="cn-loading">
              <span className="cn-spinner" />
              <span>
                {node.status === "queued" ? "待機中…" : "生成中…"}
                {elapsed ? <span className="cn-elapsed"> {elapsed}</span> : null}
              </span>
              {(hasPrompt || hasModel) && (
                <button className="cn-loading-detail nodrag" onClick={() => setInspectorOpen(true)}>
                  内容を確認
                </button>
              )}
            </div>
          )}
        </div>

        <div className="cn-chip-type">{labelOf(node.type)}</div>
        <span className="cn-status-dot" style={{ background: STATUS_COLOR[node.status] }} title={node.error || node.status} />

        {/* always-on controls; detailed settings live in the side inspector */}
        <div className="cn-overlaybar nodrag">
          {hasRun && (
            <button className="cn-ob-run" onClick={() => void onRun()} disabled={blocked}>
              {generating ? "生成中…" : busy ? "…" : node.data.outputs.length ? "↻" : "Run"}
            </button>
          )}
          {isUpload && (
            <label className="cn-ob-btn">
              {busy ? "…" : "画像"}
              <input type="file" accept="image/*" onChange={pick("image")} hidden />
            </label>
          )}
          {isVideoUpload && (
            <label className="cn-ob-btn">
              {busy ? "…" : "動画"}
              <input type="file" accept="video/*" onChange={pick("video")} hidden />
            </label>
          )}
          {isAudioUpload && (
            <label className="cn-ob-btn">
              {busy ? "…" : "音声"}
              <input type="file" accept="audio/*" onChange={pick("audio")} hidden />
            </label>
          )}
          {isFileImport && (
            <label className="cn-ob-btn">
              {busy ? "…" : "ファイル"}
              <input type="file" accept=".pdf,.txt,.md,.markdown,.csv,.json,.html,.htm,.log,application/pdf,text/*" onChange={pick("doc")} hidden />
            </label>
          )}
          {hasModel && (
            <button
              className={`cn-ob-chip${retired ? " retired" : ""}`}
              aria-label={`モデルを選択。現在: ${spec?.label || node.data.model || "未選択"}${retired ? "（提供終了）" : ""}`}
              title={retired ? "このモデルは現在のカタログにありません。選び直してください" : undefined}
              onClick={() => setInspectorOpen(true)}
            >
              {retired ? "⚠ " : ""}
              {spec?.label || shortModel(node.data.model) || "モデル選択"}
            </button>
          )}
          {(hasPrompt || hasParams || hasModel) && (
            <button
              ref={inspectorButtonRef}
              className={`cn-ob-btn${inspectorOpen ? " on" : ""}`}
              onClick={() => setInspectorOpen(true)}
              aria-expanded={inspectorOpen}
              aria-haspopup="dialog"
            >
              設定
            </button>
          )}
        </div>
      </div>

      {inspectorOpen && createPortal(
        <NodeInspector
          node={node}
          models={usable}
          prompt={prompt}
          setPrompt={setPrompt}
          onPromptFocus={() => (focused.current = true)}
          onPromptBlur={saveContent}
          onClose={() => {
            saveContent();
            setInspectorOpen(false);
          }}
          returnFocusRef={inspectorButtonRef}
        />,
        document.body,
      )}

      {lightbox && mediaOut &&
        createPortal(
          <div className="cn-lightbox" onClick={() => setLightbox(false)}>
            <div ref={lightboxRef} className="cn-lightbox-content" role="dialog" aria-modal="true" aria-label="出力プレビュー" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
              <button className="cn-lightbox-close" onClick={() => setLightbox(false)} aria-label="プレビューを閉じる">×</button>
              {isVideoUrl(mediaOut.url) ? <video src={mediaOut.url} controls autoPlay loop /> : <img src={mediaOut.url} alt="生成結果" />}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

// Body for frame_extract: shows the connected input video with a scrubber;
// "抽出" extracts the frame at the chosen time on the server (ffmpeg) -> image.
function FrameExtractBody({
  node,
  blocked,
  generating,
  onRun,
}: {
  node: GraphNode;
  blocked: boolean;
  generating: boolean;
  onRun: () => void;
}) {
  const graph = useStore((s) => s.graph);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState<number>(
    typeof node.data.params.time === "number" ? (node.data.params.time as number) : 0,
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inUrl = (() => {
    if (!graph) return "";
    const edge = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === "video_in",
    );
    if (!edge) return "";
    const src = graph.nodes.find((n) => n.id === edge.source);
    if (!src) return "";
    const vid = [...(src.data.outputs ?? [])].reverse().find((o) => o.kind === "video");
    return vid?.url ?? "";
  })();

  const out = node.data.outputs[node.data.outputs.length - 1];
  const max = Number.isFinite(dur) && dur > 0 ? dur : 0;

  function commit(time: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateNode(node.id, { data: { params: { time } } }).catch(() => {});
    }, 250);
  }
  function seek(time: number) {
    const clamped = Math.max(0, Math.min(max || time, time));
    setT(clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
    commit(clamped);
  }
  async function runHere() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      await api.updateNode(node.id, { data: { params: { time: t } } });
    } catch {
      /* ignore */
    }
    onRun();
  }

  if (!inUrl) {
    return (
      <div className="cn-body">
        <div className="cn-empty">video_in に動画ノードを接続してください</div>
      </div>
    );
  }

  return (
    <div className="cn-body cn-fx">
      <video
        ref={videoRef}
        src={inUrl}
        muted
        playsInline
        preload="auto"
        className="cn-media"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration || 0;
          setDur(d);
          const p = node.data.params.time;
          let init =
            typeof p === "number"
              ? p
              : String(p ?? "").toLowerCase() === "last"
                ? Math.max(0, d - 0.05)
                : 0;
          init = Math.max(0, Math.min(d || init, init));
          setT(init);
          e.currentTarget.currentTime = init;
        }}
      />
      <div className="cn-fx-ctrls nodrag">
        <input
          type="range"
          min={0}
          max={max}
          step={0.01}
          value={t}
          disabled={!max}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="cn-fx-row">
          <span className="cn-fx-time">
            {fmtTime(t)} / {fmtTime(dur)}
          </span>
          <button className="cn-fx-q" onClick={() => seek(0)}>先頭</button>
          <button className="cn-fx-q" onClick={() => seek(max / 2)}>中央</button>
          <button className="cn-fx-q" onClick={() => seek(Math.max(0, max - 0.05))}>末尾</button>
        </div>
        <button className="cn-ob-run" onClick={runHere} disabled={blocked || !max}>
          {generating ? "抽出中…" : "このコマを抽出"}
        </button>
        {out && out.kind === "image" && (
          <img src={out.url} alt="frame" className="cn-fx-thumb" />
        )}
      </div>
    </div>
  );
}
