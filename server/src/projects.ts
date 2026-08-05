import { EventEmitter } from "node:events";
import { Canvas, type CanvasEvent } from "./canvas.js";
import * as store from "./persistence.js";

export interface ScopedEvent {
  projectId: string;
  event: CanvasEvent;
}

// Manages one Canvas instance per project, loaded lazily. Every mutation is
// persisted, so unloading a project is safe. Only opened projects sit in memory.
export class ProjectManager extends EventEmitter {
  private canvases = new Map<string, Canvas>();

  async getCanvas(id: string): Promise<Canvas> {
    const existing = this.canvases.get(id);
    if (existing) return existing;
    const meta = await store.getProject(id);
    if (!meta) throw new Error(`project not found: ${id}`);
    const graph = await store.loadProjectGraph(id);
    const canvas = new Canvas(id, graph ?? undefined);
    canvas.on("event", (event: CanvasEvent) =>
      this.emit("event", { projectId: id, event } satisfies ScopedEvent),
    );
    this.canvases.set(id, canvas);
    return canvas;
  }

  list() {
    return store.listProjects();
  }
  get(id: string) {
    return store.getProject(id);
  }
  create(name: string) {
    return store.createProject(name || "Untitled");
  }
  async rename(id: string, name: string) {
    const c = this.canvases.get(id);
    if (c) {
      c.setName(name);
      return (await store.getProject(id))!;
    }
    return store.renameProject(id, name);
  }
  async remove(id: string) {
    this.canvases.delete(id);
    await store.deleteProject(id);
  }
  duplicate(id: string, name?: string) {
    return store.duplicateProject(id, name);
  }
}
