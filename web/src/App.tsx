import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as RfEdge,
  type FinalConnectionState,
  type Node as RfNode,
  type NodeChange,
  type NodeTypes,
  type OnConnectStartParams,
} from "@xyflow/react";
import { api } from "./api";
import {
  initStore, useStore, getNode, closeProject, refreshGraph,
  isArchived, archiveNode, restoreNode, permanentlyDelete, undoLastArchive,
} from "./store";
import { CanvasNode } from "./CanvasNode";
import { CutEdge } from "./CutEdge";
import { Dashboard } from "./Dashboard";
import { PORTS, inKind, outKind } from "./ports";
import { labelOf } from "./labels";
import type { NodeType, OutputKind, PortIn, PortOut } from "./types";

// node types that can receive an output of `kind`, with the input port to use
function candidatesFor(kind: OutputKind): { type: NodeType; port: PortIn }[] {
  const res: { type: NodeType; port: PortIn }[] = [];
  for (const t of Object.keys(PORTS) as NodeType[]) {
    const inp = PORTS[t].inputs.find((i) => i.kind === kind);
    if (inp) res.push({ type: t, port: inp.port });
  }
  return res;
}

const edgeTypes = { cut: CutEdge };

const nodeTypes: NodeTypes = {
  image_gen: CanvasNode,
  image_edit: CanvasNode,
  video_gen: CanvasNode,
  image_upload: CanvasNode,
  video_upload: CanvasNode,
  audio_upload: CanvasNode,
  video_upscale: CanvasNode,
  audio_gen: CanvasNode,
  video_to_audio: CanvasNode,
  transcribe: CanvasNode,
  llm_text: CanvasNode,
  av_mux: CanvasNode,
  video_concat: CanvasNode,
  frame_extract: CanvasNode,
  note: CanvasNode,
  doc: CanvasNode,
  web_clip: CanvasNode,
  file_import: CanvasNode,
  frame: CanvasNode,
};

// Default node size (px) per type; persisted overrides live in data.params.w/h.
function defaultSize(t: NodeType): { w: number; h: number } {
  if (t === "frame") return { w: 480, h: 320 };
  if (t === "note") return { w: 260, h: 210 };
  if (t === "doc") return { w: 280, h: 300 };
  if (t === "web_clip" || t === "file_import") return { w: 260, h: 230 };
  if (t === "llm_text" || t === "transcribe") return { w: 300, h: 320 }; // text output needs reading room
  // audio nodes render a player, which is short
  if (t === "audio_upload" || t === "audio_gen" || t === "video_to_audio") return { w: 280, h: 170 };
  if (
    t === "video_gen" ||
    t === "video_upscale" ||
    t === "video_concat" ||
    t === "video_upload" ||
    t === "av_mux"
  )
    return { w: 300, h: 280 };
  if (t === "frame_extract") return { w: 300, h: 340 };
  return { w: 280, h: 300 }; // image_gen / image_edit / image_upload
}

// Grouped node palette for the "+ Add node" menu (scales as types grow).
const NODE_GROUPS: { label: string; types: NodeType[] }[] = [
  { label: "画像", types: ["image_gen", "image_edit", "image_upload"] },
  { label: "動画", types: ["video_gen", "video_upload", "video_upscale", "video_concat", "frame_extract"] },
  { label: "音声", types: ["audio_gen", "video_to_audio", "av_mux", "transcribe", "audio_upload"] },
  { label: "テキスト / 情報", types: ["llm_text", "note", "doc", "web_clip", "file_import"] },
  { label: "レイアウト", types: ["frame"] },
];

function Flow() {
  const graph = useStore((s) => s.graph);
  const connected = useStore((s) => s.connected);
  const mock = useStore((s) => s.mock);
  const projectName = useStore((s) => s.projectName);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RfNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RfEdge>([]);
  const rf = useReactFlow();
  const connecting = useRef<{ nodeId: string; handleId: string } | null>(null);
  // ダブルクリックで開くノード作成メニュー。sx/sy は画面座標。
  const [spawn, setSpawn] = useState<{ sx: number; sy: number } | null>(null);

  // 画面座標を「そこにノードの中心が来る」flow 座標に変換する。
  // 左上を合わせると大きいノードほど狙った位置からずれるので中心合わせにする。
  const flowPosCenteredAt = useCallback(
    (screen: { x: number; y: number }, type: NodeType) => {
      const f = rf.screenToFlowPosition(screen);
      const d = defaultSize(type);
      return { x: Math.round(f.x - d.w / 2), y: Math.round(f.y - d.h / 2) };
    },
    [rf],
  );

  const [picker, setPicker] = useState<
    | null
    | { sx: number; sy: number; flow: { x: number; y: number }; source: string; handle: PortOut; kind: OutputKind }
  >(null);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // Drag-and-drop from Finder / OS: images → image_upload, videos → video_upload,
  // audio → audio_upload, PDF/text → file_import.
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onCanvasDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }, []);
  const onCanvasDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }, []);
  const onCanvasDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      const base = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const pos = { x: base.x + i * 32, y: base.y + i * 32 };
        const isImage = f.type.startsWith("image/");
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        const isVideo =
          f.type.startsWith("video/") || /^(mp4|webm|mov|m4v|mkv)$/.test(ext);
        const isAudio =
          !isVideo &&
          (f.type.startsWith("audio/") || /^(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/.test(ext));
        const isDoc =
          !isImage && !isVideo && !isAudio &&
          /^(pdf|txt|md|markdown|csv|json|html|htm|log)$/.test(ext);
        if (!isImage && !isVideo && !isAudio && !isDoc) continue;
        try {
          const node = await api.addNode({
            type: isImage
              ? "image_upload"
              : isVideo
                ? "video_upload"
                : isAudio
                  ? "audio_upload"
                  : "file_import",
            position: pos,
          });
          if (isVideo) {
            // Stream raw bytes; videos are large and base64 would exceed limits.
            await api.uploadVideoFileRaw(node.id, f);
          } else if (isAudio) {
            // Stream raw bytes too; uncompressed audio can also be large.
            await api.uploadAudioFileRaw(node.id, f);
          } else {
            const dataUrl: string = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = () => res(String(r.result));
              r.onerror = () => rej(r.error);
              r.readAsDataURL(f);
            });
            if (isImage) await api.uploadFile(node.id, dataUrl);
            else await api.importFile(node.id, dataUrl, f.name);
          }
        } catch (err) {
          alert(`drop failed: ${(err as Error).message}`);
        }
      }
    },
    [rf],
  );

  // sync store graph -> react-flow (preserve local selection)
  useEffect(() => {
    if (!graph) return;
    const archivedIds = new Set(graph.nodes.filter(isArchived).map((n) => n.id));
    setRfNodes((prev) =>
      graph.nodes.filter((n) => !archivedIds.has(n.id)).map((n) => {
        const ex = prev.find((p) => p.id === n.id);
        const isFrame = n.type === "frame";
        const d = defaultSize(n.type);
        const w = Number(n.data.params.w ?? d.w);
        const aspect = Number(n.data.params.aspect ?? 0);
        // node height follows the content's aspect ratio when known
        const h =
          aspect > 0
            ? Math.max(150, Math.min(760, Math.round(w / aspect)))
            : Number(n.data.params.h ?? d.h);
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          selected: ex?.selected ?? false,
          data: { node: n },
          zIndex: isFrame ? 0 : 1, // frames sit behind regular nodes
          style: { width: w, height: h },
        } as RfNode;
      }),
    );
    setRfEdges(
      graph.edges
        .filter((e) => !archivedIds.has(e.source) && !archivedIds.has(e.target))
        .map((e) => ({
        id: e.id,
        type: "cut",
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
    );
  }, [graph, setRfNodes, setRfEdges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<RfNode>[]) => {
      onNodesChange(changes);
      for (const c of changes) {
        if (c.type === "position" && c.dragging === false && c.position) {
          api.updateNode(c.id, { position: c.position }).catch(() => {});
        }
      }
    },
    [onNodesChange],
  );

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle)
      return;
    // optimistic add; server echo via WS reconciles
    setRfEdges((eds) => addEdge(conn, eds));
    api
      .connect({
        source: conn.source,
        sourceHandle: conn.sourceHandle as "image_out" | "video_out",
        target: conn.target,
        targetHandle: conn.targetHandle as PortIn,
      })
      .catch((err) => {
        alert(`connect rejected: ${(err as Error).message}`);
        setRfEdges((eds) =>
          eds.filter(
            (e) =>
              !(
                e.source === conn.source &&
                e.target === conn.target &&
                e.sourceHandle === conn.sourceHandle &&
                e.targetHandle === conn.targetHandle
              ),
          ),
        );
      });
  }, [setRfEdges]);

  const onConnectStart = useCallback(
    (_e: unknown, p: OnConnectStartParams) => {
      connecting.current =
        p.handleType === "source" && p.nodeId && p.handleId
          ? { nodeId: p.nodeId, handleId: p.handleId }
          : null;
    },
    [],
  );

  // Drop a connection on empty canvas → offer to create a connected node.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, conn: FinalConnectionState) => {
      const c = connecting.current;
      connecting.current = null;
      if (!c) return;
      if (conn.isValid || conn.toNode) return; // landed on a node/handle
      const src = getNode(c.nodeId);
      if (!src) return;
      const kind = outKind(src.type);
      if (!kind) return;
      const me = "clientX" in event ? event : event.touches[0];
      setPicker({
        sx: me.clientX,
        sy: me.clientY,
        flow: rf.screenToFlowPosition({ x: me.clientX, y: me.clientY }),
        source: c.nodeId,
        handle: c.handleId as PortOut,
        kind,
      });
    },
    [rf],
  );

  const createConnected = useCallback(
    async (type: NodeType, port: PortIn) => {
      if (!picker) return;
      const p = picker;
      setPicker(null);
      try {
        const node = await api.addNode({ type, position: p.flow });
        await api.connect({ source: p.source, sourceHandle: p.handle, target: node.id, targetHandle: port });
      } catch (err) {
        alert((err as Error).message);
      }
    },
    [picker],
  );

  // 空白のダブルクリックで作成メニューを開く。
  // ReactFlow は onDoubleClick を DOM へ転送しないので、ペイン要素へ直接張る。
  // ノード・ハンドル・エッジ上のダブルクリックは既存操作なので拾わない
  // （判定は event.target が pane 自身かどうかで行う）。
  // ペインはマウントのタイミングが読めないので document に張り、
  // event.target がペイン自身の時だけ反応させる。
  useEffect(() => {
    const onDbl = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t?.classList?.contains("react-flow__pane")) return;
      ev.preventDefault();
      setPicker(null);
      setSpawn({ sx: ev.clientX, sy: ev.clientY });
    };
    document.addEventListener("dblclick", onDbl);
    return () => document.removeEventListener("dblclick", onDbl);
  }, []);

  const createAtSpawn = useCallback(
    async (type: NodeType) => {
      if (!spawn) return;
      const at = { x: spawn.sx, y: spawn.sy };
      setSpawn(null);
      await api
        .addNode({ type, position: flowPosCenteredAt(at, type) })
        .catch((err) => alert((err as Error).message));
    },
    [spawn, flowPosCenteredAt],
  );

  const isValidConnection = useCallback((conn: Connection | RfEdge) => {
    const s = getNode(conn.source);
    const t = getNode(conn.target);
    if (!s || !t || !conn.targetHandle) return false;
    return outKind(s.type) === inKind(t.type, conn.targetHandle as PortIn);
  }, []);

  // Delete key / removal → archive (recoverable), never a hard delete.
  const onNodesDelete = useCallback((deleted: RfNode[]) => {
    for (const n of deleted) archiveNode(n.id);
  }, []);

  // Ctrl/Cmd+Z → un-archive the most recently archived node.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (undoLastArchive()) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onEdgesDelete = useCallback((deleted: RfEdge[]) => {
    for (const e of deleted) api.disconnect(e.id).catch(() => {});
  }, []);

  // メニューからの作成は「今見えている画面の中央」に置く。
  // 固定座標だと、スクロール先では画面外に作られて探しに行く羽目になる。
  async function addNode(type: NodeType) {
    const el = document.querySelector(".react-flow") as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    const center = r
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    await api
      .addNode({ type, position: flowPosCenteredAt(center, type) })
      .catch((err) => alert((err as Error).message));
  }

  const archivedNodes = graph?.nodes.filter(isArchived) ?? [];
  const nodeCount = (graph?.nodes.length ?? 0) - archivedNodes.length;
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  return (
    <div className="app">
      <header className="toolbar">
        <button className="back-btn" onClick={closeProject} title="プロジェクト一覧へ">
          ←
        </button>
        <strong>{projectName || "Pika Canvas"}</strong>
        <span className="sep" />
        <div className="addmenu">
          <button className="addmenu-btn" onClick={() => setMenuOpen((o) => !o)}>
            + ノード ▾
          </button>
          {menuOpen && (
            <div className="addmenu-panel" onMouseLeave={() => setMenuOpen(false)}>
              {NODE_GROUPS.map((g) => (
                <div key={g.label} className="addmenu-group">
                  <div className="addmenu-label">{g.label}</div>
                  {g.types.map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        addNode(t);
                        setMenuOpen(false);
                      }}
                      title={t}
                    >
                      {labelOf(t)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="sep" />
        <span className={`pill ${connected ? "ok" : "bad"}`}>
          {connected ? "● live" : "○ offline"}
        </span>
        {mock && <span className="pill mock">MOCK (no cost)</span>}
        <span className="muted">{nodeCount} nodes</span>
        <button
          className="ghost-btn"
          onClick={async () => {
            setResyncing(true);
            await refreshGraph();
            setTimeout(() => setResyncing(false), 400);
          }}
          disabled={resyncing}
          title="生成中のまま固まった時などにグラフを再取得"
        >
          {resyncing ? "更新中…" : "↻ 再同期"}
        </button>
        <button
          className={`archive-btn${archiveOpen ? " on" : ""}`}
          onClick={() => setArchiveOpen((o) => !o)}
          title="アーカイブ（不要アセットの格納庫・復元できます）"
        >
          🗄 アーカイブ{archivedNodes.length ? ` (${archivedNodes.length})` : ""}
        </button>
      </header>

      <div
        className={`canvas${dragOver ? " dragover" : ""}`}
        onDragEnter={onCanvasDragEnter}
        onDragOver={onCanvasDragOver}
        onDragLeave={onCanvasDragLeave}
        onDrop={onCanvasDrop}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{ type: "cut" }}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          isValidConnection={isValidConnection}
          elevateNodesOnSelect={false}
          fitView
          deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background />
          <Controls />
        </ReactFlow>

        {/* 空白ダブルクリックからの作成。クリックした位置にそのまま作られる。 */}
        {spawn && (
          <>
            <div className="picker-backdrop" onClick={() => setSpawn(null)} />
            <div className="picker-menu spawn-menu" style={{ left: spawn.sx, top: spawn.sy }}>
              <div className="picker-title">ここにノードを作成</div>
              {NODE_GROUPS.map((g) => (
                <div key={g.label} className="spawn-group">
                  <div className="spawn-group-label">{g.label}</div>
                  {g.types.map((t) => (
                    <button key={t} onClick={() => createAtSpawn(t)} title={t}>
                      {labelOf(t)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {picker && (
          <>
            <div className="picker-backdrop" onClick={() => setPicker(null)} />
            <div className="picker-menu" style={{ left: picker.sx, top: picker.sy }}>
              <div className="picker-title">接続して作成（{picker.kind}）</div>
              {candidatesFor(picker.kind).map(({ type, port }) => (
                <button key={type} onClick={() => createConnected(type, port)} title={type}>
                  {labelOf(type)} <span className="picker-port">{port}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {archiveOpen && (
          <div className="archive-panel nodrag">
            <div className="archive-head">
              <span>🗄 アーカイブ（{archivedNodes.length}）</span>
              <button className="archive-x" onClick={() => setArchiveOpen(false)}>×</button>
            </div>
            <div className="archive-hint">Deleteキー / 📥でここに格納。Ctrl+Zで直前の格納を即復元。</div>
            <div className="archive-list">
              {archivedNodes.length === 0 && (
                <div className="archive-empty">アーカイブは空です</div>
              )}
              {archivedNodes.map((n) => {
                const o = n.data.outputs[n.data.outputs.length - 1];
                const isVideo = !!o && o.kind === "video" && /\.(mp4|webm|mov)$/i.test(o.url);
                const isImage = !!o && o.kind !== "text" && !isVideo && !!o.url;
                const isText = !!o && o.kind === "text";
                const noteText =
                  (n.type === "note" || n.type === "doc") ? n.data.prompt : null;
                const label = n.data.prompt?.trim()?.slice(0, 40) || n.type;
                const superseded = n.data.params?.archivedReason === "superseded";
                return (
                  <div key={n.id} className="archive-item">
                    {isImage ? (
                      <img src={o!.url} alt="" className="archive-thumb" />
                    ) : isVideo ? (
                      <video
                        src={o!.url}
                        className="archive-thumb"
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : isText ? (
                      <div className="archive-thumb text">
                        {(o!.text || "").slice(0, 80) || "(空)"}
                      </div>
                    ) : noteText ? (
                      <div className="archive-thumb text">
                        {noteText.slice(0, 80) || "(空)"}
                      </div>
                    ) : (
                      <div className="archive-thumb ph">{n.type}</div>
                    )}
                    <div className="archive-meta">
                      <div className="archive-type">
                        {n.type}
                        {superseded && <span className="archive-tag">旧バージョン</span>}
                      </div>
                      <div className="archive-id" title={n.id}>{n.id}</div>
                      <div className="archive-label">{label}</div>
                    </div>
                    <div className="archive-actions">
                      <button onClick={() => restoreNode(n.id)} title="キャンバスに戻す">復元</button>
                      <button
                        className="danger"
                        onClick={() => {
                          if (window.confirm(`完全に削除しますか？\n${n.type}  ${n.id}\nこの操作は元に戻せません。`))
                            permanentlyDelete(n.id);
                        }}
                        title="完全に削除（取り消し不可）"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  useEffect(() => {
    void initStore();
  }, []);
  const view = useStore((s) => s.view);
  if (view === "dashboard") return <Dashboard />;
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
