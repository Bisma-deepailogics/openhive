/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, session, shell } = require("electron");

const APP_NAME = "Orbit";
const APP_URL = process.env.ORBIT_URL || "https://www.openhivedemo.com";
const APP_ORIGIN = new URL(APP_URL).origin;
const PROTOCOLS = ["orbit"];

let mainWindow = null;
let pendingDeepLink = null;

function routeDeepLink(value) {
  try {
    const url = new URL(value);
    if (PROTOCOLS.includes(url.protocol.replace(":", ""))) {
      const workspace = url.searchParams.get("workspace");
      return workspace ? `/auth?workspace=${encodeURIComponent(workspace)}` : "/";
    }

    if (url.origin === APP_ORIGIN) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Ignore command-line arguments that are not URLs.
  }
  return null;
}

function openDeepLink(value) {
  const route = routeDeepLink(value);
  if (!route) return false;

  if (!mainWindow) {
    pendingDeepLink = route;
    return true;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.loadURL(new URL(route, APP_URL).toString());
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  const initialRoute = pendingDeepLink || "/";
  pendingDeepLink = null;
  mainWindow.loadURL(new URL(initialRoute, APP_URL).toString());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (routeDeepLink(url)) {
      openDeepLink(url);
    } else {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, target) => {
    try {
      if (new URL(target).origin === APP_ORIGIN) return;
    } catch {
      // Invalid navigation targets are treated as external.
    }

    event.preventDefault();
    shell.openExternal(target);
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: `${APP_NAME} could not connect`,
      message: "Orbit could not connect to the company server.",
      detail: `${description}\n\n${url}\n\nCheck your internet connection and try again.`,
      buttons: ["Retry", "Close"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && mainWindow) mainWindow.webContents.reload();
      else if (response === 1) app.quit();
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerPermissions() {
  const allowed = new Set(["media", "notifications", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(details.requestingUrl).origin === APP_ORIGIN;
      } catch {
        // Deny requests without a valid app URL.
      }
      callback(sameOrigin && allowed.has(permission));
    },
  );
}

function registerProtocol() {
  for (const protocol of PROTOCOLS) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(protocol, process.execPath, [process.argv[1]]);
    } else {
      app.setAsDefaultProtocolClient(protocol);
    }
  }
}

function findDeepLink(argv) {
  return argv.find((arg) => PROTOCOLS.some((protocol) => arg.startsWith(`${protocol}://`)));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerProtocol();

  app.on("second-instance", (_event, argv) => {
    const deepLink = findDeepLink(argv);
    if (!deepLink || !openDeepLink(deepLink)) {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    openDeepLink(url);
  });

  app.whenReady().then(() => {
    const deepLink = findDeepLink(process.argv);
    if (deepLink) pendingDeepLink = routeDeepLink(deepLink);
    registerPermissions();
    createWindow();
  });

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
