'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a safe, minimal API to the renderer via window.noteSearch.
 * All calls go through IPC — the renderer never touches Node.js directly.
 */
contextBridge.exposeInMainWorld('noteSearch', {

  // ── Config ────────────────────────────────────────────────────────────────
  getConfig: () =>
    ipcRenderer.invoke('get-config'),

  saveConfig: (updates) =>
    ipcRenderer.invoke('save-config', updates),

  pickDirectory: () =>
    ipcRenderer.invoke('pick-directory'),

  // ── Search ────────────────────────────────────────────────────────────────
  search: (query) =>
    ipcRenderer.invoke('search', query),

  // ── Index ─────────────────────────────────────────────────────────────────
  reindex: () =>
    ipcRenderer.invoke('reindex'),

  getStats: () =>
    ipcRenderer.invoke('get-stats'),

  // ── File Actions ──────────────────────────────────────────────────────────
  openFile: (filePath) =>
    ipcRenderer.invoke('open-file', filePath),

  revealFile: (filePath) =>
    ipcRenderer.invoke('reveal-file', filePath),

  // ── Event Listeners ───────────────────────────────────────────────────────
  onIndexUpdated: (cb) => {
    ipcRenderer.on('index-updated', (_, data) => cb(data));
  },

  onConfigChanged: (cb) => {
    ipcRenderer.on('config-changed', (_, data) => cb(data));
  },

  onOpenSettings: (cb) => {
    ipcRenderer.on('open-settings', () => cb());
  },

  // Clean up listeners to avoid memory leaks
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
