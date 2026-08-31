/**
 * OpenHive — Electron main process.
 *
 * OpenHive is a full Next.js server app (App Router + API routes + middleware),
 * so loading static files (file:// / `output: export`) is not possible. Instead
 * this shell boots a real Next.js server and renders it in a BrowserWindow:
 *
 *   npm run electron:dev     → `next dev` on a free port (hot reload)
 *   npm run electron:preview → `.next/standalone/server.js` (production build)
 *   npm run electron:build   → Windows installer via electron-builder
 *
 * Set `OPENHIVE_URL=http://localhost:3000` to attach to an already-running
 * server instead of spawning a new one.
 */

const { app, BrowserWindow, dialog, session, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const APP_NAME = "OpenHive";
const START_TIMEOUT_MS = 120000;

let mainWindow = null;
let serverProcess = null;
let appOrigin = null;
let quitting = false;
let logFileStream = null;
let lastServerOutput = "";

/* --------------------------------- helpers --------------------------------- */

/** Server output goes to console (dev) and to %APPDATA%/OpenHive/next-server.log. */
function logServerChunk(chunk) {
  lastServerOutput = (lastServerOutput + chunk).slice(-4000);
  try {
    process.stdout.write(chunk);
  } catch {
    /* stdout unavailable in packaged GUI mode */
  }
  try {
    logFileStream?.write(chunk);
  } catch {
    /* log stream closed */
  }
}

function openServerLogFile(header) {
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    logFileStream = fs.createWriteStream(path.join(dir, "next-server.log"), { flags: "w" });
    logFileStream.write(header);
  } catch {
    logFileStream = null;
  }
}

function closeServerLogFile() {
  try {
    logFileStream?.end();
  } catch {
    /* ignore */
  }
  logFileStream = null;
}

/** First free TCP port on 127.0.0.1, so dev/preview never collide with anything. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal .env parser so server-only secrets reach the spawned Next server. */
function loadEnvFile(file) {
  const vars = {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[m[1]] = value;
    }
  } catch {
    /* file missing — fine */
  }
  return vars;
}

/** Poll the server URL until it answers (any HTTP response counts as ready). */
function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(
      () => reject(new Error(`Next.js server did not start within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    const attempt = () => {
      if (quitting) {
        clearTimeout(timer);
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        clearTimeout(timer);
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) return; // the timer will reject
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

/** Kill the spawned server — on Windows the whole process tree (taskkill /T). */
function killServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

/**
 * Env files merged into the server's environment (lowest → highest priority):
 *   1. <project>/.env.local                      (dev + preview)
 *   2. <resources>/server/.env.local             (packaged, optional)
 *   3. <userData>/.env.local                     (%APPDATA%\OpenHive — user-editable)
 * Real environment variables (setx) always win over file values.
 */
function collectEnvFiles() {
  const files = [path.join(app.getAppPath(), ".env.local")];
  if (app.isPackaged) {
    files.push(path.join(process.resourcesPath, "server", ".env.local"));
  }
  try {
    files.push(path.join(app.getPath("userData"), ".env.local"));
  } catch {
    /* userData unavailable before ready */
  }
  return files;
}

function buildServerEnv(extraEnv) {
  const merged = {};
  for (const file of collectEnvFiles()) {
    Object.assign(merged, loadEnvFile(file));
  }
  return { ...merged, ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv };
}

/**
 * Run the Next server with Electron's bundled Node runtime
 * (ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave like plain node).
 * Child processes Next.js spawns inherit this env, so the whole tree is Node.
 */
function spawnServerProcess(args, cwd, extraEnv) {
  return spawn(process.execPath, args, {
    cwd,
    env: buildServerEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function startServer() {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  if (app.isPackaged) {
    // Packaged installer: standalone server copied to resources/server by
    // electron-builder (see "build.extraResources" in package.json).
    const serverJs = path.join(process.resourcesPath, "server", "server.js");
    if (!fs.existsSync(serverJs)) throw new Error(`Bundled server not found: ${serverJs}`);
    serverProcess = spawnServerProcess([serverJs], path.dirname(serverJs), {
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
    });
  } else if (process.env.OPENHIVE_MODE === "prod") {
    // Local production preview against `next build` output.
    const serverJs = path.join(app.getAppPath(), ".next", "standalone", "server.js");
    if (!fs.existsSync(serverJs)) {
      throw new Error(
        'Standalone build not found — run "npm run build" first (npm run electron:preview does it automatically).',
      );
    }
    serverProcess = spawnServerProcess([serverJs], path.dirname(serverJs), {
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
    });
  } else {
    // Development: boot `next dev` with hot reload.
    const nextBin = path.join(app.getAppPath(), "node_modules", "next", "dist", "bin", "next");
    if (!fs.existsSync(nextBin)) throw new Error("next binary not found — run `npm install` first.");
    serverProcess = spawnServerProcess([nextBin, "dev", "-p", String(port)], app.getAppPath(), {
      NODE_ENV: "development",
    });
  }

  openServerLogFile(
    `[${new Date().toISOString()}] mode=${app.isPackaged ? "packaged" : process.env.OPENHIVE_MODE === "prod" ? "preview" : "dev"} server=${serverProcess.spawnfile} pid=${serverProcess.pid}\n`,
  );
  serverProcess.stdout?.on("data", logServerChunk);
  serverProcess.stderr?.on("data", logServerChunk);
  serverProcess.on("exit", (code) => {
    serverProcess = null;
    closeServerLogFile();
    if (!quitting) {
      const tail = lastServerOutput.trim().split(/\r?\n/).slice(-6).join("\n");
      dialog.showErrorBox(
        APP_NAME,
        `The Next.js server exited unexpectedly (code ${code}).\n\n` +
          (tail ? `Server output:\n${tail}\n\n` : "") +
          `Full log: ${path.join(app.getPath("userData"), "next-server.log")}`,
      );
      app.quit();
    }
  });

  await waitForServer(url, START_TIMEOUT_MS);
  return url;
}

function createWindow(url) {
  appOrigin = url;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(url);

  // Same-origin popups stay inside the app; everything else (docs, mailto:,
  // external links) opens in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(appOrigin)) return { action: "allow" };
    shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** LiveKit calls need mic/camera — grant whatever the app itself asks for. */
function registerPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    const requesting = details.requestingUrl || "";
    callback(!appOrigin || requesting.startsWith(appOrigin));
  });
}

/* --------------------------------- lifecycle -------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerPermissions();
    try {
      const url = process.env.OPENHIVE_URL || (await startServer());
      createWindow(url);
    } catch (err) {
      const tail = lastServerOutput.trim().slice(-1200);
      dialog.showErrorBox(APP_NAME, `${String((err && err.message) || err)}\n\n${tail}`);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      quitting = true;
      killServer();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    killServer();
  });
}