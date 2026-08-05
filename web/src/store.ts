import { useSyncExternalStore } from "react";
import type { Graph, GraphNode, ModelSpec, ProjectMeta, ServerEvent } from "./types";
import { api, setProject } from "./api";

type View = "dashboard" | "project";

interface State {
  view: View;
  projectId: string;
  projectName: string;
  graph: Graph | null;
  projects: ProjectMeta[];
  models: ModelSpec[];
  mock: boolean;
  connected: boolean;
}

let state: State = {
  view: "dashboard",
  projectId: "",
  projectName: "",
  graph: null,
  projects: [],
  models: [],
  mock: false,
  connected: false,
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

function applyEvent(ev: ServerEvent) {
  const g = state.graph;
  if (!g) return;
  let nodes = g.nodes;
  let edges = g.edges;
  switch (ev.type) {
    case "node:added":
      nodes = [...nodes.filter((n) => n.id !== ev.node.id), ev.node];
      break;
    case "node:updated":
      nodes = nodes.map((n) => (n.id === ev.node.id ? ev.node : n));
      break;
    case "node:deleted":
      nodes = nodes.filter((n) => n.id !== ev.id);
      edges = edges.filter((e) => e.source !== ev.id && e.target !== ev.id);
      break;
    case "edge:added":
      edges = [...edges.filter((e) => e.id !== ev.edge.id), ev.edge];
      break;
    case "edge:removed":
      edges = edges.filter((e) => e.id !== ev.id);
      break;
    case "node:status":
      nodes = nodes.map((n) =>
        n.id === ev.id ? { ...n, status: ev.status, error: ev.error } : n,
      );
      break;
    case "node:output":
      nodes = nodes.map((n) =>
        n.id === ev.id
          ? { ...n, data: { ...n.data, outputs: [...n.data.outputs, ev.output] } }
          : n,
      );
      break;
    case "viewport":
      set({ graph: { ...g, viewport: ev.viewport } });
      return;
  }
  set({ graph: { ...g, nodes, edges } });
}

let ws: WebSocket | null = null;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    set({ connected: true });
    if (state.projectId) {
      subscribe(state.projectId);
      // After a (possibly silent) WS reconnect, ws-derived events for jobs that
      // finished while we were disconnected are gone. Force a fresh graph so the
      // UI catches up immediately.
      void refreshGraph();
    }
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.kind === "snapshot") {
      if (data.projectId === state.projectId) set({ graph: data.graph, mock: data.mock });
    } else if (data.kind === "event") {
      applyEvent(data.event as ServerEvent);
    } else if (data.kind === "projects") {
      // Live project list (agent/MCP or other-client edits) — keeps the
      // dashboard current without a reload.
      set({ projects: data.projects as ProjectMeta[] });
    }
  };
}
function subscribe(projectId: string) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "subscribe", projectId }));
}

let started = false;
export async function initStore() {
  if (started) return;
  started = true;
  try {
    const [models, projects] = await Promise.all([api.getModels(), api.listProjects()]);
    set({ models, projects });
  } catch {
    /* server may still be starting */
  }
  connectWs();
  startStuckPoller();
}

// ---- stuck-state poller ----------------------------------------------------
// WebSocket connections can die silently (e.g. laptop sleep, network blip) —
// the browser keeps the socket "open" but events stop arriving, so a node that
// finished while disconnected stays "running" in the UI forever. While any
// running/queued node exists, periodically refetch the graph as a safety net.
let stuckTimer: ReturnType<typeof setInterval> | null = null;
function startStuckPoller() {
  if (stuckTimer) return;
  stuckTimer = setInterval(() => {
    if (state.view !== "project" || !state.projectId || !state.graph) return;
    const busy = state.graph.nodes.some(
      (n) => n.status === "running" || n.status === "queued",
    );
    if (busy) void refreshGraph();
  }, 12000);
}

export async function refreshGraph() {
  if (!state.projectId) return;
  const pid = state.projectId;
  try {
    const fresh = await api.getGraph();
    // The user may have switched projects mid-fetch — only apply if still on it.
    if (state.projectId === pid) set({ graph: fresh });
  } catch {
    /* ignore transient */
  }
}

export async function refreshProjects() {
  try {
    set({ projects: await api.listProjects() });
  } catch {
    /* ignore */
  }
}

export async function openProject(p: ProjectMeta) {
  setProject(p.id);
  set({ view: "project", projectId: p.id, projectName: p.name, graph: null });
  subscribe(p.id);
  try {
    set({ graph: await api.getGraph() });
  } catch {
    /* snapshot will arrive via ws */
  }
}

export function closeProject() {
  set({ view: "dashboard", projectId: "", graph: null });
  void refreshProjects();
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

export function getNode(id: string): GraphNode | undefined {
  return state.graph?.nodes.find((n) => n.id === id);
}

// ---- archive / soft-delete with undo ----
// Archived nodes stay in the graph (params.archived=true) but are hidden from the
// canvas and listed in the Archive panel. Nothing is lost on a normal "delete".
let archiveHistory: string[] = [];

export function isArchived(n: GraphNode): boolean {
  return !!n.data.params?.archived;
}

export function archiveNode(id: string) {
  archiveHistory = archiveHistory.filter((x) => x !== id);
  archiveHistory.push(id);
  api.updateNode(id, { data: { params: { archived: true } } }).catch(() => {});
}

export function restoreNode(id: string) {
  archiveHistory = archiveHistory.filter((x) => x !== id);
  api.updateNode(id, { data: { params: { archived: false } } }).catch(() => {});
}

// Ctrl+Z: un-archive the most recently archived node still in the archive.
export function undoLastArchive(): boolean {
  while (archiveHistory.length) {
    const id = archiveHistory.pop()!;
    const n = getNode(id);
    if (n && isArchived(n)) {
      api.updateNode(id, { data: { params: { archived: false } } }).catch(() => {});
      return true;
    }
  }
  return false;
}

export function permanentlyDelete(id: string) {
  archiveHistory = archiveHistory.filter((x) => x !== id);
  api.deleteNode(id).catch(() => {});
}
