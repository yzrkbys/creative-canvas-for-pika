import type {
  Edge,
  Graph,
  GraphNode,
  ModelSpec,
  NodeType,
  PortIn,
  PortOut,
  ProjectMeta,
  RunResult,
} from "./types";

// Parse a response body as JSON, but degrade gracefully when the server returns
// non-JSON (e.g. an HTML error page from the body-size limit or a proxy). Without
// this, such responses surface as a cryptic `Unexpected token '<'` parse error.
function parseJsonSafe(text: string, status: number): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(`HTTP ${status}: ${snippet || "non-JSON response"}`);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = parseJsonSafe(await res.text(), res.status);
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// Stream a raw file body to the server (no base64, no JSON). For large media
// like video that would otherwise inflate +33% and exceed the JSON body limit.
async function reqRaw<T>(method: string, path: string, file: File): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const json = parseJsonSafe(await res.text(), res.status);
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// The active project all scoped calls operate on (set when a project is opened).
let pid = "";
export function setProject(id: string) {
  pid = id;
}
const P = () => `/api/projects/${pid}`;

export const api = {
  // global
  getModels: () => req<ModelSpec[]>("GET", "/api/models"),

  // projects
  listProjects: () => req<ProjectMeta[]>("GET", "/api/projects"),
  createProject: (name: string) => req<ProjectMeta>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) =>
    req<ProjectMeta>("PATCH", `/api/projects/${id}`, { name }),
  deleteProject: (id: string) => req("DELETE", `/api/projects/${id}`),
  duplicateProject: (id: string, name?: string) =>
    req<ProjectMeta>("POST", `/api/projects/${id}/duplicate`, { name }),

  // scoped to the active project
  getGraph: () => req<Graph>("GET", `${P()}/graph`),
  addNode: (args: {
    type: NodeType;
    position?: { x: number; y: number };
    data?: Partial<{ prompt: string; model: string; params: Record<string, unknown> }>;
  }) => req<GraphNode>("POST", `${P()}/nodes`, args),
  updateNode: (
    id: string,
    patch: {
      position?: { x: number; y: number };
      data?: Partial<{ prompt: string; model: string; params: Record<string, unknown> }>;
    },
  ) => req<GraphNode>("PATCH", `${P()}/nodes/${id}`, patch),
  deleteNode: (id: string) => req("DELETE", `${P()}/nodes/${id}`),
  connect: (args: {
    source: string;
    sourceHandle: PortOut;
    target: string;
    targetHandle: PortIn;
  }) => req<Edge>("POST", `${P()}/edges`, args),
  disconnect: (id: string) => req("DELETE", `${P()}/edges/${id}`),
  run: (id: string, confirm?: boolean) =>
    req<RunResult>("POST", `${P()}/nodes/${id}/run`, { confirm: !!confirm }),
  cancelNode: (id: string) =>
    req<{ cancelled: boolean }>("POST", `${P()}/nodes/${id}/cancel`, {}),
  uploadFile: (id: string, dataUrl: string) =>
    req("POST", `${P()}/nodes/${id}/upload-file`, { dataUrl }),
  uploadVideoFile: (id: string, dataUrl: string) =>
    req("POST", `${P()}/nodes/${id}/upload-video`, { dataUrl }),
  uploadVideoFileRaw: (id: string, file: File) =>
    reqRaw("POST", `${P()}/nodes/${id}/upload-video-raw`, file),
  uploadAudioFile: (id: string, dataUrl: string) =>
    req("POST", `${P()}/nodes/${id}/upload-audio`, { dataUrl }),
  uploadAudioFileRaw: (id: string, file: File) =>
    reqRaw("POST", `${P()}/nodes/${id}/upload-audio-raw`, file),
  importFile: (id: string, dataUrl: string, filename: string) =>
    req("POST", `${P()}/nodes/${id}/import-file`, { dataUrl, filename }),
};
