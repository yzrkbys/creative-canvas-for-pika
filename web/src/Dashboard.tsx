import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useStore, openProject, refreshProjects } from "./store";
import type { ProjectMeta } from "./types";

type Dialog =
  | { mode: "create"; value: string }
  | { mode: "rename"; id: string; value: string }
  | null;

export function Dashboard() {
  const projects = useStore((s) => s.projects);
  const connected = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Manual refresh — instant, explicit, and the fallback when the live socket
  // is offline. With the socket up, the list already updates on its own.
  async function manualRefresh() {
    setRefreshing(true);
    try {
      await refreshProjects();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (dialog) inputRef.current?.focus();
  }, [dialog]);

  async function confirmDialog() {
    if (!dialog) return;
    const name = dialog.value.trim();
    if (!name) return;
    setBusy(true);
    try {
      if (dialog.mode === "create") {
        const p = await api.createProject(name);
        await refreshProjects();
        setDialog(null);
        void openProject(p);
      } else {
        await api.renameProject(dialog.id, name);
        await refreshProjects();
        setDialog(null);
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(p: ProjectMeta) {
    await api.duplicateProject(p.id).catch((e) => alert((e as Error).message));
    refreshProjects();
  }
  async function remove(p: ProjectMeta) {
    if (!window.confirm(`「${p.name}」を削除しますか？（元に戻せません）`)) return;
    await api.deleteProject(p.id).catch((e) => alert((e as Error).message));
    refreshProjects();
  }

  return (
    <div className="dash">
      <header className="dash-head">
        <strong>Creative Canvas</strong>
        {/* The full name is "Creative Canvas for Pika API Club". The header
            shows the wordmark plus the qualifier that says whose API this
            drives — spelled out, because "unofficial" has to be visible in the
            product, not only in the README. */}
        <span className="muted" title="Pika API Club 用の非公式クライアントです（Pika 社とは無関係）">
          for Pika API Club
        </span>
        <span className="muted">プロジェクト</span>
        <span
          className={`pill ${connected ? "ok" : "bad"}`}
          title={connected ? "リアルタイム同期中（Agent/MCPの変更も自動反映）" : "サーバ未接続。「更新」で再読み込みできます"}
        >
          {connected ? "● ライブ同期" : "○ オフライン"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={manualRefresh} disabled={refreshing} title="一覧を再読み込み">
          {refreshing ? "更新中…" : "↻ 更新"}
        </button>
        <button onClick={() => setDialog({ mode: "create", value: "Untitled" })} disabled={busy}>
          + 新規プロジェクト
        </button>
      </header>

      <div className="dash-grid">
        {projects.length === 0 && (
          <div className="muted">
            プロジェクトがありません。「+ 新規プロジェクト」で作成してください。
          </div>
        )}
        {projects.map((p) => (
          <div key={p.id} className="proj-card" onClick={() => openProject(p)}>
            <div className="proj-name">{p.name}</div>
            <div className="proj-meta">
              {p.nodeCount} nodes · {new Date(p.updatedAt).toLocaleString()}
            </div>
            <div className="proj-actions" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setDialog({ mode: "rename", id: p.id, value: p.name })}>
                改名
              </button>
              <button onClick={() => duplicate(p)}>複製</button>
              <button className="danger" onClick={() => remove(p)}>
                削除
              </button>
            </div>
          </div>
        ))}
      </div>

      {dialog && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {dialog.mode === "create" ? "新規プロジェクト" : "プロジェクト名を変更"}
            </div>
            <input
              ref={inputRef}
              className="modal-input"
              value={dialog.value}
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmDialog();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setDialog(null)}>キャンセル</button>
              <button className="primary" onClick={confirmDialog} disabled={busy}>
                {dialog.mode === "create" ? "作成して開く" : "変更"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
