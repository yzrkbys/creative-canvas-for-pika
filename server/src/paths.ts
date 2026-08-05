import path from "node:path";

// Writable base dir. The desktop app points this at ~/Library/Application Support;
// dev defaults to the current working directory.
export const BASE_DIR = process.env.PIKA_CANVAS_DATA_DIR
  ? path.resolve(process.env.PIKA_CANVAS_DATA_DIR)
  : process.cwd();

// Each project owns a directory: projects/<id>/{graph.json, assets/}
export const PROJECTS_DIR = path.join(BASE_DIR, "projects");
export const INDEX_FILE = path.join(PROJECTS_DIR, "index.json");

export const projectDir = (id: string) => path.join(PROJECTS_DIR, id);
export const projectGraphFile = (id: string) => path.join(projectDir(id), "graph.json");
export const projectAssetsDir = (id: string) => path.join(projectDir(id), "assets");

// Resolve a served asset URL ("/assets/<pid>/<name>") to its filesystem path.
export function resolveAssetPath(url: string): string {
  const rel = url.replace(/^.*\/assets\//, ""); // strip host + /assets/
  const [pid, ...rest] = rel.split("/");
  const name = path.basename(rest.join("/") || "");
  return path.join(projectAssetsDir(pid), name);
}
