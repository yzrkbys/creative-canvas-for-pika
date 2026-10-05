const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { fork, spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Must be set before any getPath("userData") so settings and projects live in a
// folder named after the app rather than after the npm package.
const APP_NAME = "Creative Canvas for Pika API Club";
const PREVIOUS_APP_NAME = "Pika Canvas";
app.setName(APP_NAME);

// One instance per data directory. macOS refuses a second launch of the same
// bundle by itself, but Windows happily starts another copy on a second click
// of the shortcut — a second server writing the same projects/*.json as the
// first. The lock is taken after setName because it is keyed on userData.
const HAS_LOCK = app.requestSingleInstanceLock();
if (!HAS_LOCK) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// The app was called "Pika Canvas" until 2026-09-02, and Electron derives the
// data directory from the name — so renaming it would strand every existing
// project in a folder the app no longer reads: 3.6 GB of work, apparently gone,
// with no error to explain it. First launch after the rename moves the old
// folder's contents across.
//
// The test is what the new directory CONTAINS, not whether it exists. Electron
// creates userData during startup, before this file's body runs, so by the time
// we look it is always there — populated with Chromium's caches and nothing of
// ours. Checking existence made the migration silently skip itself on the very
// first real run.
//
// Only our own payload moves. Chromium state (caches, cookies) is disposable
// and belongs to whichever directory produced it.
const PAYLOAD = ["projects", ".env", "pika-catalog.json"];

function hasProjects(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, "projects"))
      .some((name) => fs.statSync(path.join(dir, "projects", name)).isDirectory());
  } catch {
    return false; // no projects directory at all
  }
}

// A .env written by ensureEnvFile() but never filled in is not worth keeping:
// the old one has the key the user actually pasted.
function isPlaceholderEnv(file) {
  try {
    return !/^\s*PIKA_API_KEY\s*=\s*\S/m.test(fs.readFileSync(file, "utf8"));
  } catch {
    return true;
  }
}

function resolveDataDir() {
  const wanted = app.getPath("userData");
  const previous = path.join(path.dirname(wanted), PREVIOUS_APP_NAME);
  if (hasProjects(wanted) || !hasProjects(previous)) return wanted;

  let moved = 0;
  for (const name of PAYLOAD) {
    const from = path.join(previous, name);
    const to = path.join(wanted, name);
    if (!fs.existsSync(from)) continue;
    try {
      if (fs.existsSync(to)) {
        // Only .env is ever expected here, and only as an unfilled template.
        if (name !== ".env" || !isPlaceholderEnv(to)) continue;
        fs.rmSync(to);
      }
      fs.mkdirSync(wanted, { recursive: true });
      fs.renameSync(from, to);
      moved++;
    } catch (err) {
      console.error(`[app] could not move ${name}: ${err.message}`);
    }
  }

  if (moved) {
    console.log(
      `[app] migrated ${moved} item(s) from "${PREVIOUS_APP_NAME}" to "${APP_NAME}"`,
    );
  }
  // If the projects never made it, use the folder that still has them rather
  // than opening onto an empty canvas that looks like the work is gone.
  return hasProjects(wanted) ? wanted : previous;
}
const DATA_DIR = resolveDataDir();
const net = require("node:net");
const http = require("node:http");

let serverProc = null;
let win = null;
let port = 0;

// --- settings (.env in writable userData dir) ---
function envPath() {
  return path.join(DATA_DIR, ".env");
}
function ensureEnvFile() {
  const p = envPath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      [
        `# ${APP_NAME} 設定ファイル`,
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
// Open the settings file for editing. Returns an error message, or "" on success.
// Windows has no program associated with a bare ".env", so shell.openPath only
// raises an "open with" prompt there (or fails); Notepad is always present.
async function openSettingsFile(p) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const child = spawn("notepad.exe", [p], { detached: true, stdio: "ignore" });
      child.once("error", (err) => resolve(err.message));
      child.once("spawn", () => {
        child.unref();
        resolve("");
      });
    });
  }
  return shell.openPath(p);
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
      path.join(DATA_DIR, "server-port"),
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
      PIKA_CANVAS_DATA_DIR: DATA_DIR,
      PIKA_CANVAS_WEB_DIR: resourcePath("web"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
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
    title: APP_NAME,
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
            const failed = await openSettingsFile(ensureEnvFile());
            dialog.showMessageBox(win, {
              message: failed ? "設定ファイルを開けませんでした" : "設定ファイルを開きました",
              detail: failed
                ? `${envPath()} をテキストエディタで開いて PIKA_API_KEY を書いてください。\n(${failed})`
                : "PIKA_API_KEY を編集して保存したら、「設定を反映して再起動」を選んでください。",
              buttons: ["OK"],
            });
          },
        },
        {
          label: "設定を反映して再起動",
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
        {
          label: "保存フォルダを開く",
          click: () => shell.openPath(DATA_DIR),
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
  if (!HAS_LOCK) return; // quitting: the running instance has been focused instead
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
