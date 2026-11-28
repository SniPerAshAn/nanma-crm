// Nanma CRM – Windows desktop app.
// Opens the live CRM in its own window. CRM updates arrive automatically (it loads the website).
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage } = require("electron");
const path = require("path");

const CRM = "https://crm.nanmabranding.cloud";
const ORIGIN = new URL(CRM).origin;
let win = null, tray = null, quitting = false;

app.setAppUserModelId("com.nanmabranding.crm"); // needed for Windows notifications
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

const isCRM = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: "Nanma CRM", icon: path.join(__dirname, "build", "icon.ico"),
    backgroundColor: "#ffffff", autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true }
  });
  win.removeMenu();
  win.loadURL(CRM);
  win.once("ready-to-show", () => { if (!process.argv.includes("--hidden")) win.show(); });

  // Links to other websites (Instagram, Drive…) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isCRM(url)) return { action: "allow" };
    shell.openExternal(url); return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!isCRM(url)) { e.preventDefault(); shell.openExternal(url); } });

  // Offline / server unreachable: show a friendly page with retry.
  win.webContents.on("did-fail-load", (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="font-family:Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="text-align:center"><h2>Can't reach Nanma CRM</h2><p>Check your internet connection.</p>
       <button onclick="location.href='${CRM}'" style="padding:10px 22px;font-size:15px;background:#000;color:#fff;border:0;border-radius:8px;cursor:pointer">Try again</button></div></body>`));
  });

  // Keyboard: F5 / Ctrl+R reload, Ctrl+Shift+I dev tools, Ctrl +/- zoom.
  win.webContents.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown") return;
    const k = i.key.toLowerCase();
    if (k === "f5" || (i.control && k === "r")) { win.webContents.reload(); e.preventDefault(); }
    else if (i.control && i.shift && k === "i") { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (i.control && (k === "=" || k === "+")) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (i.control && k === "-") { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (i.control && k === "0") { win.webContents.setZoomLevel(0); e.preventDefault(); }
  });

  // Closing the window keeps the app in the tray so notifications keep coming.
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")));
  tray.setToolTip("Nanma CRM");
  const build = () => Menu.buildFromTemplate([
    { label: "Open Nanma CRM", click: () => { win.show(); win.focus(); } },
    { label: "Reload", click: () => win.webContents.reload() },
    { type: "separator" },
    { label: "Start when Windows starts", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked, args: ["--hidden"] }); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(build());
  tray.on("right-click", () => tray.setContextMenu(build()));
  tray.on("click", () => { win.isVisible() && win.isFocused() ? win.hide() : (win.show(), win.focus()); });
}

app.whenReady().then(() => {
  // Allow notifications and microphone (voice notes) for the CRM only.
  const ok = new Set(["notifications", "media", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(ok.has(perm) && isCRM(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => ok.has(perm) && isCRM(origin || ""));

  createWindow();
  createTray();
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {}); // stay in tray
