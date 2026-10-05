#!/usr/bin/env node
/**
 * Smoke test for the server bundle the desktop app ships (build/server.cjs).
 *
 * Runs it the way the app does — a separate process with its own data dir —
 * in mock mode (no API key, no cost), and drives one generation and one
 * ffmpeg job through the HTTP API. It exists so the Windows build can be
 * checked on a Windows machine or CI runner without clicking through the UI:
 * paths, ffmpeg discovery and process spawning are where the platforms differ.
 *
 *   npm -w desktop run build:all && node desktop/smoke.mjs
 *
 * Needs ffmpeg on PATH (or PIKA_CANVAS_FFMPEG / PIKA_CANVAS_FFPROBE).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "build", "server.cjs");
if (!existsSync(bundle)) {
  console.error(`missing ${bundle} — run "npm -w desktop run build:all" first`);
  process.exit(1);
}

const PORT = Number(process.env.SMOKE_PORT) || 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "canvas-smoke-"));

const env = { ...process.env, PORT: String(PORT), PIKA_CANVAS_DATA_DIR: dataDir, MOCK_PROVIDER: "1", MOCK_LATENCY_MS: "1500" };
delete env.PIKA_API_KEY; // mock mode must never be one typo away from billing
const server = spawn(process.execPath, [bundle], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.error ?? ""}`);
  return json;
}
async function waitFor(pid, nodeId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = await api("GET", `/api/projects/${pid}/graph`);
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n && (n.status === "succeeded" || n.status === "failed")) return n;
    await sleep(500);
  }
  throw new Error(`node ${nodeId} did not finish in ${timeoutMs}ms`);
}

try {
  // --- boot ---
  let health;
  for (let i = 0; i < 60 && !health; i++) {
    health = await api("GET", "/api/health").catch(() => null);
    if (!health) await sleep(500);
  }
  check(!!health?.ok && health.mock === true, "server answers /api/health in mock mode");
  const models = await api("GET", "/api/models");
  check(models.length > 100, `model registry loaded (${models.length} models)`);
  check(models.some((m) => m.id === "pika/pika/video-merge/merge-videos"), "Pika Video Merge is offered");

  const { id: pid } = await api("POST", "/api/projects", { name: "smoke" });

  // --- a generation: the run record must be visible while it runs ---
  const img = await api("POST", `/api/projects/${pid}/nodes`, {
    type: "image_gen",
    data: { prompt: "smoke test prompt" },
  });
  await api("POST", `/api/projects/${pid}/nodes/${img.id}/run`, { confirm: true });
  const running = (await api("GET", `/api/projects/${pid}/graph`)).nodes.find((x) => x.id === img.id);
  check(running.lastRun?.prompt === "smoke test prompt", "lastRun carries the prompt while the job runs");
  // edit mid-run: must not leak into this run's record
  await api("PATCH", `/api/projects/${pid}/nodes/${img.id}`, { data: { prompt: "edited mid-run" } });
  const done = await waitFor(pid, img.id);
  const out = done.data.outputs.at(-1);
  check(done.status === "succeeded", `image job succeeded${done.error ? ` (${done.error})` : ""}`);
  check(out?.meta.request?.prompt === "smoke test prompt", "output records the prompt it was made with");
  check(!!out?.meta.providerJobId, "output records the provider job id");

  // --- ffmpeg: two clips -> local concat ---
  const ffmpeg = process.env.PIKA_CANVAS_FFMPEG || "ffmpeg";
  const clips = [];
  for (const [i, src] of ["testsrc", "testsrc2"].entries()) {
    const file = path.join(dataDir, `clip${i}.mp4`);
    const r = spawnSync(ffmpeg, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `${src}=size=320x240:rate=24`, "-t", "1", "-pix_fmt", "yuv420p", file], { windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg could not make a test clip: ${r.error?.message ?? r.stderr}`);
    clips.push(file);
  }
  const concat = await api("POST", `/api/projects/${pid}/nodes`, { type: "video_concat", position: { x: 600, y: 0 } });
  check(concat.data.model === "builtin/video-concat", "video_concat defaults to the local ffmpeg concat");
  for (const [i, file] of clips.entries()) {
    const v = await api("POST", `/api/projects/${pid}/nodes`, { type: "video_upload", position: { x: 100 + i * 200, y: 0 } });
    // a native path (backslashes on Windows) goes through the upload-by-path route
    await api("POST", `/api/projects/${pid}/nodes/${v.id}/upload-video`, { path: file });
    await api("POST", `/api/projects/${pid}/edges`, { source: v.id, sourceHandle: "video_out", target: concat.id, targetHandle: "clip_in" });
  }
  await api("POST", `/api/projects/${pid}/nodes/${concat.id}/run`, { confirm: true });
  const joined = await waitFor(pid, concat.id);
  check(joined.status === "succeeded", `local concat succeeded${joined.error ? ` (${joined.error})` : ""}`);
  const url = joined.data.outputs.at(-1)?.url ?? "";
  const res = url ? await fetch(BASE + url) : null;
  const bytes = res?.ok ? (await res.arrayBuffer()).byteLength : 0;
  check(bytes > 1000, `concat output is served (${bytes} bytes)`);
  const onDisk = path.join(dataDir, "projects", pid, "assets", path.basename(url));
  check(existsSync(onDisk) && statSync(onDisk).size === bytes, "concat output is on disk under the data dir");
} catch (err) {
  failures++;
  console.error("FAIL", err.message);
} finally {
  server.kill();
  await sleep(300);
  if (failures) console.error("\n--- server log ---\n" + log);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows can hold the files a moment longer; the OS temp dir is fine */
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
