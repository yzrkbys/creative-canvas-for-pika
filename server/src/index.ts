import dotenv from "dotenv";
import path from "node:path";
import http from "node:http";

// Load .env from the writable data dir if set (desktop app), else cwd (dev).
dotenv.config(
  process.env.PIKA_CANVAS_DATA_DIR
    ? { path: path.join(process.env.PIKA_CANVAS_DATA_DIR, ".env") }
    : {},
);

import { WebSocketServer, WebSocket } from "ws";
import { createHttpApp } from "./http.js";
import { ProjectManager, type ScopedEvent } from "./projects.js";
import * as store from "./persistence.js";
import { isMockMode } from "./providers/index.js";
import { CATALOG, MODELS } from "./registry.js";
import { checkCatalogDrift } from "./catalog-check.js";

async function main() {
  await store.init(); // create projects dir + migrate any legacy single graph

  const projects = new ProjectManager();
  const app = createHttpApp(projects);
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });
  const subscription = new Map<WebSocket, string>(); // socket -> projectId

  // Broadcast a project's state events only to clients viewing that project.
  projects.on("event", ({ projectId, event }: ScopedEvent) => {
    const data = JSON.stringify({ kind: "event", event });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && subscription.get(client) === projectId)
        client.send(data);
    }
  });

  // Push the live project list to *every* connected client whenever the index
  // changes. This is what keeps the dashboard in sync with agent/MCP edits
  // (create/rename/delete/duplicate, and node count bumps) without a reload.
  // Bursts (e.g. rapid status updates during a run) are coalesced: the first
  // change schedules one broadcast 200ms later that reads the latest list.
  let broadcastPending = false;
  function broadcastProjects() {
    if (broadcastPending) return;
    broadcastPending = true;
    setTimeout(async () => {
      broadcastPending = false;
      let list;
      try {
        list = await store.listProjects();
      } catch {
        return;
      }
      const data = JSON.stringify({ kind: "projects", projects: list });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      }
    }, 200);
  }
  store.projectsEvents.on("changed", broadcastProjects);

  wss.on("connection", (ws) => {
    // Greet with the current project list so a freshly (re)connected client is
    // immediately in sync, even if it missed changes while disconnected.
    void store.listProjects().then((list) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ kind: "projects", projects: list }));
    });

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && typeof msg.projectId === "string") {
          subscription.set(ws, msg.projectId);
          const canvas = await projects.getCanvas(msg.projectId);
          ws.send(
            JSON.stringify({
              kind: "snapshot",
              projectId: msg.projectId,
              graph: canvas.getGraph(),
              mock: isMockMode(),
            }),
          );
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on("close", () => subscription.delete(ws));
  });

  // Fire and forget: a stale snapshot must be visible before a paid run,
  // but it must never delay or block the server coming up.
  void checkCatalogDrift();

  const port = Number(process.env.PORT ?? 8797);
  server.listen(port, () => {
    console.log(`[canvas-server] http://localhost:${port}`);
    console.log(`[canvas-server] ws   ws://localhost:${port}/ws`);
    console.log(
      `[canvas-server] provider: ${
        isMockMode()
          ? "MOCK (no cost)"
          : process.env.PIKA_API_KEY
            ? `pika · ${MODELS.length} models (catalog ${CATALOG.syncedAt.slice(0, 10)})`
            : "PIKA_API_KEY not set"
      }`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
