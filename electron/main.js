/**
 * OpenHive — Electron main process.
 *
 * OpenHive is a full Next.js server app (App Router + API routes + middleware),
 * so loading static files (file:// / `output: export`) is not possible. Instead
 * this shell boots a real Next.js server and renders it in a BrowserWindow:
 *
 *   npm run electron:dev     → `next dev` on a free port (hot reload)
 *   npm run electron:preview → `.next/standalone/server.js` (production build)
 *   npm run electron:build   → platform installers via electron-builder
 *                              (NSIS exe / AppImage + deb / dmg)
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
/** Custom URL scheme for shareable invite links: openhive://join?workspace=<id>. */
const DESKTOP_SCHEME = "openhive";

let mainWindow = null;
let serverProcess = null;
let appOrigin = null;
let quitting = false;
let logFileStream = null;
let lastServerOutput = "";
/** /auth?workspace=... path to open as soon as the window/server is ready. */
let pendingDeepLinkPath = null;

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
  // A deep link that arrived before the window existed opens right away.
  const initialPath = pendingDeepLinkPath;
  pendingDeepLinkPath = null;
  mainWindow.loadURL(initialPath ? `${appOrigin}${initialPath}` : url);

  // Same-origin popups stay inside the app; shared invite links (any origin,
  // or openhive://) are rewritten to the local server; everything else
  // (docs, mailto:, external links) opens in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(appOrigin)) return { action: "allow" };
    const invitePath = routeIncomingUrl(target);
    if (invitePath) {
      mainWindow.loadURL(`${appOrigin}${invitePath}`);
      return { action: "deny" };
    }
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Non-popup navigations: same-origin is allowed; invite links from other
  // machines (or openhive:// links) are rerouted to the local server; any
  // other external URL goes to the system browser, not the app window.
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(appOrigin)) return;
    event.preventDefault();
    const invitePath = routeIncomingUrl(target);
    if (invitePath) mainWindow.loadURL(`${appOrigin}${invitePath}`);
    else shell.openExternal(target);
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

/** Start the Next server (unless OPENHIVE_URL is set) and open the window. */
function launchApp() {
  (async () => {
    const url = process.env.OPENHIVE_URL || (await startServer());
    createWindow(url);
  })().catch((err) => {
    const tail = lastServerOutput.trim().slice(-1200);
    dialog.showErrorBox(APP_NAME, `${String((err && err.message) || err)}\n\n${tail}`);
    app.quit();
  });
}

/* --------------------------- deep links (invites) --------------------------- */

/**
 * Register the openhive:// scheme so shared invite links open the installed
 * app on any machine. electron-builder also registers the scheme at install
 * time via "build.protocols" (Windows registry, macOS Info.plist, .desktop).
 */
function registerDesktopProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DESKTOP_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient(DESKTOP_SCHEME);
    }
  } catch {
    /* already registered or unsupported */
  }
}

/** openhive://join?workspace=<id> → workspace id, otherwise null. */
function parseDeepLink(url) {
  if (typeof url !== "string" || !url.startsWith(`${DESKTOP_SCHEME}://`)) return null;
  try {
    return new URL(url).searchParams.get("workspace") || null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a shared invite link to a path on THIS machine's local server.
 * Every computer runs its own server, so an invite URL must never keep a
 * foreign origin. Handles openhive:// links and any http(s) …/auth?workspace=
 * URL (e.g. copied from another computer, or clicked inside a chat message).
 */
function routeIncomingUrl(target) {
  const workspace = parseDeepLink(target);
  if (workspace) return `/auth?workspace=${encodeURIComponent(workspace)}`;
  try {
    const u = new URL(target);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.pathname.replace(/\/+$/, "") === "/auth" &&
      u.searchParams.get("workspace")
    ) {
      const params = new URLSearchParams({ workspace: u.searchParams.get("workspace") });
      const email = u.searchParams.get("email");
      if (email) params.set("email", email);
      return `/auth?${params.toString()}`;
    }
  } catch {
    /* not a parseable URL */
  }
  return null;
}

/**
 * Apply a deep link: navigate the window now when the server is ready,
 * otherwise queue it — createWindow opens it as soon as everything is up.
 */
function applyDeepLink(url) {
  const invitePath = routeIncomingUrl(url);
  if (!invitePath) return false;
  if (mainWindow && appOrigin) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.loadURL(`${appOrigin}${invitePath}`);
  } else {
    pendingDeepLinkPath = invitePath;
    if (appOrigin) createWindow(appOrigin);
  }
  return true;
}

/* --------------------------------- lifecycle -------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDesktopProtocol();

  app.on("second-instance", (_event, argv) => {
    // Windows/Linux protocol launches arrive here with the URL in argv.
    const linkArg = (argv || []).find(
      (a) => typeof a === "string" && a.startsWith(`${DESKTOP_SCHEME}://`),
    );
    if (!linkArg || !applyDeepLink(linkArg)) {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    }
  });

  // macOS protocol launches (app already running or cold start).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    applyDeepLink(url);
  });

  app.whenReady().then(() => {
    // Cold-start protocol launch on Windows/Linux: the URL is in argv.
    const linkArg = process.argv.find(
      (a) => typeof a === "string" && a.startsWith(`${DESKTOP_SCHEME}://`),
    );
    if (linkArg) applyDeepLink(linkArg);
    registerPermissions();
    launchApp();
  });

  // macOS keeps the app running after the last window closes; clicking the
  // dock icon must bring the window back (re-using the already-running server).
  app.on("activate", () => {
    if (process.platform !== "darwin") return;
    if (mainWindow) {
      mainWindow.show();
      return;
    }
    // If the server is still starting, createWindow() runs when it resolves.
    if (appOrigin) createWindow(appOrigin);
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