import path from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { Canvas } from "./canvas.js";
import type { ProjectManager } from "./projects.js";
import { projectAssetsDir } from "./paths.js";
import { streamToAssets } from "./assets.js";
import { isMockMode } from "./providers/index.js";
import { MODELS } from "./registry.js";
import { catalogDrift } from "./catalog-check.js";

// Wrap an async handler so thrown errors become 400 JSON.
function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  };
}

export function createHttpApp(projects: ProjectManager) {
  const app = express();
  app.use(cors());
  // Image/doc data: URLs (base64) ride the JSON body; videos stream raw instead.
  app.use(express.json({ limit: "100mb" }));

  // Resolve the project's Canvas, then run the handler.
  const hc =
    (fn: (c: Canvas, req: Request, res: Response) => unknown) =>
    (req: Request, res: Response) =>
      h(async (rq, rs) => fn(await projects.getCanvas(rq.params.pid), rq, rs))(req, res);

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, mock: isMockMode(), catalog: catalogDrift() }));
  app.get("/api/models", (_req, res) => res.json(MODELS));

  // ---- project CRUD ----
  app.get("/api/projects", h(() => projects.list()));
  app.post("/api/projects", h((req) => projects.create(req.body?.name)));
  app.patch("/api/projects/:pid", h((req) => projects.rename(req.params.pid, req.body.name)));
  app.delete("/api/projects/:pid", h(async (req) => {
    await projects.remove(req.params.pid);
    return { ok: true };
  }));
  app.post("/api/projects/:pid/duplicate", h((req) =>
    projects.duplicate(req.params.pid, req.body?.name),
  ));

  // ---- project-scoped reads ----
  app.get("/api/projects/:pid/graph", hc((c) => c.getGraph()));
  app.get("/api/projects/:pid/cost", hc((c) => c.costSummary()));
  app.get("/api/projects/:pid/graph/compact", hc((c) => c.getGraphCompact()));
  app.get("/api/projects/:pid/jobs/:jid", hc((c, req) => {
    const job = c.getJob(req.params.jid);
    if (!job) throw new Error(`job not found: ${req.params.jid}`);
    return job;
  }));
  app.get("/api/projects/:pid/nodes/:id/text", hc((c, req) => c.getText(req.params.id)));

  // ---- structure ----
  app.post("/api/projects/:pid/nodes", hc((c, req) => c.addNode(req.body)));
  app.patch("/api/projects/:pid/nodes/:id", hc((c, req) => c.updateNode(req.params.id, req.body)));
  app.delete("/api/projects/:pid/nodes/:id", hc((c, req) => {
    c.deleteNode(req.params.id);
    return { ok: true };
  }));
  app.post("/api/projects/:pid/nodes/:id/run", hc((c, req) => c.run(req.params.id, req.body ?? {})));
  app.post("/api/projects/:pid/nodes/:id/cancel", hc((c, req) => c.cancelNode(req.params.id)));
  app.post("/api/projects/:pid/edges", hc((c, req) => c.connect(req.body)));
  app.delete("/api/projects/:pid/edges/:id", hc((c, req) => {
    c.disconnect(req.params.id);
    return { ok: true };
  }));
  app.post("/api/projects/:pid/jobs/:jid/cancel", hc((c, req) => {
    c.cancel(req.params.jid);
    return { ok: true };
  }));

  // ---- sugar ----
  app.post("/api/projects/:pid/nodes/:id/prompt", hc((c, req) => c.setPrompt(req.params.id, req.body.text)));
  app.post("/api/projects/:pid/nodes/:id/model", hc((c, req) => c.setModel(req.params.id, req.body.model)));
  app.post("/api/projects/:pid/nodes/:id/params", hc((c, req) => c.setParams(req.params.id, req.body.params ?? req.body)));
  app.patch("/api/projects/:pid/viewport", hc((c, req) => {
    c.setViewport(req.body);
    return { ok: true };
  }));

  // ---- assets ----
  app.post("/api/projects/:pid/upload", hc((c, req) => c.uploadImage(req.body.path)));
  app.post("/api/projects/:pid/upload-audio", hc((c, req) => c.uploadAudio(req.body.path)));
  app.post("/api/projects/:pid/nodes/:id/upload-file", hc((c, req) =>
    c.uploadToNode(req.params.id, req.body.dataUrl ?? req.body.path),
  ));
  app.post("/api/projects/:pid/nodes/:id/upload-video", hc((c, req) =>
    c.uploadVideoToNode(req.params.id, req.body.dataUrl ?? req.body.path),
  ));
  // Large videos: stream the raw request body straight to disk. Avoids base64
  // inflation (+33%) and the JSON body-size limit. Content-type is non-JSON, so
  // express.json passes the request through untouched.
  app.post("/api/projects/:pid/nodes/:id/upload-video-raw", hc(async (c, req) => {
    const filename = decodeURIComponent(req.header("x-filename") ?? "");
    const raw = (filename.split(".").pop() || "mp4").toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(raw) ? raw : "mp4";
    const { localUrl } = await streamToAssets(req, ext, req.params.pid);
    return c.attachVideoToNode(req.params.id, localUrl);
  }));
  app.post("/api/projects/:pid/nodes/:id/upload-audio", hc((c, req) =>
    c.uploadAudioToNode(req.params.id, req.body.dataUrl ?? req.body.path),
  ));
  // Large audio (long WAV/uncompressed): stream raw bytes straight to disk to
  // avoid base64 inflation and the JSON body-size limit, like video.
  app.post("/api/projects/:pid/nodes/:id/upload-audio-raw", hc(async (c, req) => {
    const filename = decodeURIComponent(req.header("x-filename") ?? "");
    const raw = (filename.split(".").pop() || "mp3").toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(raw) ? raw : "mp3";
    const { localUrl } = await streamToAssets(req, ext, req.params.pid);
    return c.attachAudioToNode(req.params.id, localUrl);
  }));
  app.post("/api/projects/:pid/nodes/:id/import-file", hc((c, req) =>
    c.importFileToNode(req.params.id, req.body.dataUrl, req.body.filename),
  ));
  app.post("/api/projects/:pid/import-file", hc((c, req) =>
    c.importFileFromPath(req.body.path),
  ));
  app.get("/assets/:pid/:name", (req, res) => {
    res.sendFile(path.join(projectAssetsDir(req.params.pid), path.basename(req.params.name)));
  });

  // ---- built web UI (desktop / single-port mode) ----
  const webDir = process.env.PIKA_CANVAS_WEB_DIR;
  if (webDir) {
    app.use(express.static(webDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/assets"))
        return next();
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  return app;
}
