import { useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useStore, openProject, refreshProjects } from "./store";
import type { ProjectMeta } from "./types";
import { useDismissibleLayer } from "./useDismissibleLayer";

type Dialog =
  | { mode: "create"; value: string }
  | { mode: "rename"; id: string; value: string }
  | null;

type ProjectSort = "updated-desc" | "updated-asc" | "name" | "nodes" | "created-desc";

function ProjectCard({
  project,
  onRename,
  onDuplicate,
  onRemove,
}: {
  project: ProjectMeta;
  onRename: (project: ProjectMeta) => void;
  onDuplicate: (project: ProjectMeta) => void;
  onRemove: (project: ProjectMeta) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useDismissibleLayer<HTMLDivElement>(
    menuOpen,
    () => setMenuOpen(false),
    { returnFocusRef: buttonRef },
  );

  return (
    <article className="proj-card">
      <button
        className="proj-open"
        onClick={() => void openProject(project)}
        aria-label={`「${project.name}」を開く`}
      >
        <span className="proj-name">{project.name}</span>
        <span className="proj-meta">
          {project.nodeCount} ノード · {new Date(project.updatedAt).toLocaleString("ja-JP")}
        </span>
      </button>
      <div className="proj-menu-wrap">
        <button
          ref={buttonRef}
          className="proj-menu-btn"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={`「${project.name}」の操作`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          ⋯ 操作
        </button>
        {menuOpen ? (
          <div ref={menuRef} className="proj-menu" role="menu" tabIndex={-1}>
            <button role="menuitem" onClick={() => { setMenuOpen(false); onRename(project); }}>
              名前を変更
            </button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); onDuplicate(project); }}>
              複製
            </button>
            <div className="proj-menu-sep" />
            <button className="danger" role="menuitem" onClick={() => { setMenuOpen(false); onRemove(project); }}>
              プロジェクトを削除
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function Dashboard() {
  const projects = useStore((s) => s.projects);
  const connected = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("updated-desc");
  const dialogRef = useDismissibleLayer<HTMLDivElement>(
    dialog !== null,
    () => setDialog(null),
  );

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const result = projects.filter(
      (project) =>
        !normalized ||
        project.name.toLocaleLowerCase().includes(normalized) ||
        project.id.toLocaleLowerCase().includes(normalized),
    );
    result.sort((a, b) => {
      if (sort === "updated-asc") return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
      if (sort === "name") return a.name.localeCompare(b.name, "ja");
      if (sort === "nodes") return b.nodeCount - a.nodeCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (sort === "created-desc") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
    return result;
  }, [projects, query, sort]);

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
    void refreshProjects();
  }
  async function remove(p: ProjectMeta) {
    if (!window.confirm(`「${p.name}」を削除しますか？（元に戻せません）`)) return;
    await api.deleteProject(p.id).catch((e) => alert((e as Error).message));
    void refreshProjects();
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
        <span className="dash-spacer" />
        <button className="ghost" onClick={manualRefresh} disabled={refreshing} title="一覧を再読み込み">
          {refreshing ? "更新中…" : "↻ 更新"}
        </button>
        <button onClick={() => setDialog({ mode: "create", value: "無題のプロジェクト" })} disabled={busy}>
          + 新規プロジェクト
        </button>
      </header>

      <section className="dash-controls" aria-label="プロジェクト一覧の絞り込み">
        <label className="dash-search">
          <span>検索</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="プロジェクト名を検索…"
          />
        </label>
        <label className="dash-sort">
          <span>並び順</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as ProjectSort)}>
            <option value="updated-desc">更新日時（新しい順）</option>
            <option value="updated-asc">更新日時（古い順）</option>
            <option value="name">名前（昇順）</option>
            <option value="nodes">ノード数（多い順）</option>
            <option value="created-desc">作成日時（新しい順）</option>
          </select>
        </label>
        <span className="dash-count" aria-live="polite">
          {visibleProjects.length} / {projects.length} 件
        </span>
      </section>

      <div className="dash-grid">
        {projects.length === 0 && (
          <div className="muted">
            プロジェクトがありません。「+ 新規プロジェクト」で作成してください。
          </div>
        )}
        {projects.length > 0 && visibleProjects.length === 0 ? (
          <div className="dash-empty">検索条件に一致するプロジェクトはありません</div>
        ) : null}
        {visibleProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onRename={(item) => setDialog({ mode: "rename", id: item.id, value: item.name })}
            onDuplicate={(item) => void duplicate(item)}
            onRemove={(item) => void remove(item)}
          />
        ))}
      </div>

      {dialog && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div
            ref={dialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title" id="project-dialog-title">
              {dialog.mode === "create" ? "新規プロジェクト" : "プロジェクト名を変更"}
            </div>
            <input
              className="modal-input"
              aria-label="プロジェクト名"
              data-autofocus
              value={dialog.value}
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmDialog();
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
