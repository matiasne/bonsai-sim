// Minimal, locked-down bridge. The game is a self-contained page — it needs nothing
// from Node — so we expose only a tiny marker the page can feature-detect if it ever
// wants to adapt to running inside the tray app. contextIsolation stays on.
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('bonsaiDesktop', {
  host: 'electron-tray',
  version: 1,
});
