import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  BASE_DIR,
  INDEX_FILE,
  PROJECTS_DIR,
  projectAssetsDir,
  projectDir,
  projectGraphFile,
} from "./paths.js";
import type { Graph } from "./types.js";

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

// Fires "changed" whenever the project index is written (create / rename /
// delete / duplicate, and every graph save that bumps nodeCount/updatedAt).
// The HTTP/WS layer listens to this to push the live project list to all
// clients — so an agent's MCP edits show up on the dashboard without a reload.
export const projectsEvents = new EventEmitter();

function emptyGraph(id: string, name: string): Graph {
  const now = new Date().toISOString();
  return {
    id,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: now,
  };
}

async function readIndex(): Promise<ProjectMeta[]> {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, "utf8")) as ProjectMeta[];
  } catch {
    return [];
  }
}

let indexWrite: Promise<void> = Promise.resolve();
function writeIndex(list: ProjectMeta[]): Promise<void> {
  indexWrite = indexWrite.then(async () => {
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
    await fs.writeFile(INDEX_FILE, JSON.stringify(list, null, 2), "utf8");
    projectsEvents.emit("changed");
  });
  return indexWrite;
}

async function upsertMeta(patch: ProjectMeta): Promise<void> {
  const list = await readIndex();
  const i = list.findIndex((p) => p.id === patch.id);
  if (i === -1) list.push(patch);
  else list[i] = patch;
  await writeIndex(list);
}

// ---- migration: fold a pre-existing single graph into a project ----
async function migrateLegacy(): Promise<void> {
  if ((await readIndex()).length > 0) return;
  const legacyGraph = path.join(BASE_DIR, "data", "graph.json");
  const legacyAssets = path.join(BASE_DIR, "assets");
  let migrated = false;
  try {
    const raw = await fs.readFile(legacyGraph, "utf8");
    const graph = JSON.parse(raw) as Graph;
    const id = graph.id || nanoid();
    const name = graph.name || "My First Space";
    await fs.mkdir(projectAssetsDir(id), { recursive: true });
    // move legacy assets into the project and rewrite urls /assets/x -> /assets/<id>/x
    try {
      for (const f of await fs.readdir(legacyAssets)) {
        await fs
          .rename(path.join(legacyAssets, f), path.join(projectAssetsDir(id), f))
          .catch(() => {});
      }
    } catch {
      /* no legacy assets */
    }
    const rewrite = (u?: string) =>
      u && u.startsWith("/assets/") && !u.startsWith(`/assets/${id}/`)
        ? u.replace(/^\/assets\//, `/assets/${id}/`)
        : u;
    for (const n of graph.nodes)
      for (const o of n.data.outputs) {
        o.url = rewrite(o.url)!;
        if (o.thumbUrl) o.thumbUrl = rewrite(o.thumbUrl);
      }
    graph.id = id;
    graph.name = name;
    await fs.writeFile(projectGraphFile(id), JSON.stringify(graph, null, 2), "utf8");
    await upsertMeta({
      id,
      name,
      createdAt: graph.updatedAt || new Date().toISOString(),
      updatedAt: graph.updatedAt || new Date().toISOString(),
      nodeCount: graph.nodes.length,
    });
    migrated = true;
  } catch {
    /* no legacy graph */
  }
  if (!migrated && (await readIndex()).length === 0) {
    await createProject("My First Space");
  }
}

export async function init(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await migrateLegacy();
}

// ---- project CRUD ----
export async function listProjects(): Promise<ProjectMeta[]> {
  return (await readIndex()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<ProjectMeta | undefined> {
  return (await readIndex()).find((p) => p.id === id);
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const id = nanoid();
  const now = new Date().toISOString();
  await fs.mkdir(projectAssetsDir(id), { recursive: true });
  await fs.writeFile(
    projectGraphFile(id),
    JSON.stringify(emptyGraph(id, name), null, 2),
    "utf8",
  );
  const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, nodeCount: 0 };
  await upsertMeta(meta);
  return meta;
}

export async function renameProject(id: string, name: string): Promise<ProjectMeta> {
  const meta = await getProject(id);
  if (!meta) throw new Error(`project not found: ${id}`);
  meta.name = name;
  meta.updatedAt = new Date().toISOString();
  await upsertMeta(meta);
  const g = await loadProjectGraph(id);
  if (g) {
    g.name = name;
    await saveProjectGraph(id, g);
  }
  return meta;
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(projectDir(id), { recursive: true, force: true });
  await writeIndex((await readIndex()).filter((p) => p.id !== id));
}

export async function duplicateProject(id: string, name?: string): Promise<ProjectMeta> {
  const src = await getProject(id);
  if (!src) throw new Error(`project not found: ${id}`);
  const newId = nanoid();
  const now = new Date().toISOString();
  await fs.cp(projectDir(id), projectDir(newId), { recursive: true });
  const g = await loadProjectGraph(newId);
  const newName = name ?? `${src.name} copy`;
  if (g) {
    // rewrite asset urls to the new project id
    const rewrite = (u?: string) =>
      u ? u.replace(new RegExp(`^/assets/${id}/`), `/assets/${newId}/`) : u;
    for (const n of g.nodes)
      for (const o of n.data.outputs) {
        o.url = rewrite(o.url)!;
        if (o.thumbUrl) o.thumbUrl = rewrite(o.thumbUrl);
      }
    g.id = newId;
    g.name = newName;
    await saveProjectGraph(newId, g);
  }
  const meta: ProjectMeta = {
    id: newId,
    name: newName,
    createdAt: now,
    updatedAt: now,
    nodeCount: g?.nodes.length ?? 0,
  };
  await upsertMeta(meta);
  return meta;
}

// ---- graph load/save ----
export async function loadProjectGraph(id: string): Promise<Graph | null> {
  try {
    return JSON.parse(await fs.readFile(projectGraphFile(id), "utf8")) as Graph;
  } catch {
    return null;
  }
}

const graphWrites = new Map<string, Promise<void>>();
export function saveProjectGraph(id: string, graph: Graph): Promise<void> {
  const prev = graphWrites.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(projectDir(id), { recursive: true });
    await fs.writeFile(projectGraphFile(id), JSON.stringify(graph, null, 2), "utf8");
    await upsertMeta({
      id,
      name: graph.name,
      createdAt: (await getProject(id))?.createdAt ?? graph.updatedAt,
      updatedAt: graph.updatedAt,
      nodeCount: graph.nodes.length,
    });
  });
  graphWrites.set(id, next);
  return next;
}
