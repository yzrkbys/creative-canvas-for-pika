const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
// Must be set before any getPath("userData") so settings/data live under a
// "Pika Canvas" folder rather than the package name.
app.setName("Pika Canvas");
const { fork } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");

let serverProc = null;
let win = null;
let port = 0;

// --- settings (.env in writable userData dir) ---
function envPath() {
  return path.join(app.getPath("userData"), ".env");
}
function ensureEnvFile() {
  const p = envPath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      [
        "# Pika Canvas 設定ファイル",
        "# 変更したら、アプリを再起動してください。",
        "",
        "# Pika の APIキー。これ1本で画像・動画・音声・LLM の全モデルが動きます。",
        "# https://dev.pika.art のダッシュボードで発行してください。",
        "PIKA_API_KEY=",
        "",
        "# 1 にすると mock モード（無課金・プレースホルダ生成）",
        "MOCK_PROVIDER=0",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return p;
}
function loadEnvFile(p) {
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// --- helpers ---
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
// True if nothing else is already listening on this port.
function portAvailable(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
// Prefer a stable port (so the MCP server can reach us at a fixed URL); fall
// back to a random free port if it's taken. Override with PIKA_CANVAS_PORT.
async function resolvePort() {
  const preferred = Number(process.env.PIKA_CANVAS_PORT) || 8797;
  if (await portAvailable(preferred)) return preferred;
  return freePort();
}
function waitForHealth(p, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port: p, path: "/api/health", timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("server health timeout"));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

function resourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, "build", name);
}

async function startServer() {
  port = await resolvePort();
  // Publish the resolved port so external tooling (e.g. the MCP server) can
  // discover us even when we fall back off the preferred port.
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "server-port"),
      String(port),
      "utf8",
    );
  } catch {}
  const userEnv = loadEnvFile(ensureEnvFile());
  serverProc = fork(resourcePath("server.cjs"), [], {
    env: {
      ...process.env,
      ...userEnv,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      PIKA_CANVAS_DATA_DIR: app.getPath("userData"),
      PIKA_CANVAS_WEB_DIR: resourcePath("web"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  serverProc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code) => {
    if (code && code !== 0 && !app.isQuiting) {
      dialog.showErrorBox("Canvas Server", `サーバが終了しました (code ${code})`);
    }
  });
  await waitForHealth(port);
}

// electron-builder stamps the icon into packaged builds (build.mac.icon), but
// an unpackaged run — `npm run app` — has no bundle to read it from and falls
// back to the stock Electron icon. Point at the same source file so a dev run
// is recognisable in the Dock and the switcher.
function appIconPath() {
  const p = path.join(__dirname, "buildResources", "icon.png");
  return fs.existsSync(p) ? p : null;
}

function createWindow() {
  const icon = app.isPackaged ? null : appIconPath();
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0f1419",
    title: "Pika Canvas",
    ...(icon ? { icon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Canvas",
      submenu: [
        {
          label: "設定（APIキー）を開く",
          accelerator: "CmdOrCtrl+,",
          click: async () => {
            await shell.openPath(ensureEnvFile());
            dialog.showMessageBox(win, {
              message: "設定ファイルを開きました",
              detail:
                "PIKA_API_KEY を編集して保存後、アプリを再起動すると反映されます。",
              buttons: ["OK"],
            });
          },
        },
        {
          label: "保存フォルダを開く",
          click: () => shell.openPath(app.getPath("userData")),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // macOS takes the Dock icon from the bundle, which an unpackaged run lacks —
  // it has to be set explicitly, and only after the app is ready.
  if (!app.isPackaged && process.platform === "darwin") {
    const icon = appIconPath();
    if (icon) app.dock?.setIcon(icon);
  }
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox("起動失敗", String(err));
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  app.isQuiting = true;
  if (serverProc && !serverProc.killed) serverProc.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
