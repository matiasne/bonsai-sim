// Menu-bar bonsai: a tiny Tray widget that pops down a panel showing the game.
// The sim runs only while the panel is open — on reopen the page fast-forwards the
// elapsed offline time itself (offlineAdvance on load). We just show/hide a window.
'use strict';

const { app, Tray, Menu, BrowserWindow, nativeImage, screen, shell } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
// #wallpaper hides the site chrome and shows the desktop care dock (💧🌫🧪✂️➰🍃⏩).
const GAME_URL = 'file://' + INDEX + '#wallpaper';

const PANEL_W = 360;
const PANEL_H = 440;

let tray = null;
let panel = null;
let quitting = false;

// Only one instance — a second launch just reveals the panel of the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    // the game paints a full-bleed dark scene, so match it (no transparency needed);
    // the OS window shadow gives the floating menu-bar look
    backgroundColor: '#10141f',
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the game fetches free weather APIs and (first run) may hit a CDN; allow it
      backgroundThrottling: false,
    },
  });

  panel.loadURL(GAME_URL);

  // behave like a real menu-bar dropdown: click away → hide (sim pauses)
  panel.on('blur', () => {
    if (!panel.webContents.isDevToolsOpened()) hidePanel();
  });

  // keep the window alive across hides; only really close on quit
  panel.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hidePanel(); }
  });

  // open any external links (e.g. a DNA share) in the real browser, not in the panel
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

// Position the panel under the tray icon (falls back to top-right on odd geometry).
function positionPanel() {
  const b = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea;
  let x = Math.round(b.x + b.width / 2 - PANEL_W / 2);
  let y = Math.round(b.y + b.height + 4);        // just below the menu bar
  // clamp inside the display's work area with an 8px margin
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - PANEL_W - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - PANEL_H - 8));
  panel.setPosition(x, y, false);
}

function showPanel() {
  if (!panel) createPanel();
  positionPanel();
  panel.show();
  panel.focus();
}

function hidePanel() {
  if (panel && panel.isVisible()) panel.hide();
}

function togglePanel() {
  if (panel && panel.isVisible()) hidePanel();
  else showPanel();
}

// A crisp template icon: a little pixel bonsai silhouette. Template images auto-adapt
// to light/dark menu bars on macOS. Drawn as a data URI so there's no binary asset to ship.
function trayIcon() {
  const asset = path.join(__dirname, 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(asset);
  if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
  // fallback: a simple generated glyph so the app still runs if the asset is missing
  const fallback = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgWAAAxqQE5r4l2fQAAAABJRU5ErkJggg==');
  fallback.setTemplateImage(true);
  return fallback;
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Pixel Bonsai — click to tend your tree');

  // left-click toggles the panel; right-click opens the menu
  tray.on('click', togglePanel);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Tend the bonsai', click: showPanel },
      { type: 'separator' },
      { label: 'Reload', click: () => panel && panel.webContents.reload() },
      { label: 'Quit Pixel Bonsai', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.popUpContextMenu(menu);
  });
}

app.whenReady().then(() => {
  // menu-bar app: no dock icon, no windows in the switcher
  if (app.dock) app.dock.hide();
  buildTray();
  createPanel();       // warm the window so the first click is instant
});

// A tray app has no windows to keep it alive — never quit on all-closed.
app.on('window-all-closed', (e) => { /* stay resident in the menu bar */ });
app.on('before-quit', () => { quitting = true; });
