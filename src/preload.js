/**
 * preload.js — The Security Bridge
 *
 * LEARNING MOMENT: Electron has two separate worlds:
 *   1. "Main process" (main.js) — runs Node.js, has access to your Mac's filesystem, etc.
 *   2. "Renderer process" (index.html) — runs like a browser, sandboxed for safety
 *
 * These two worlds can't talk directly (for security). This file is the controlled
 * bridge between them. It runs in a special context that has access to both worlds,
 * and it explicitly decides what the renderer is ALLOWED to call.
 *
 * Think of it like a bouncer at a club — only approved requests get through.
 */

const { contextBridge, ipcRenderer } = require('electron')

// Expose a clean API to the renderer (index.html / renderer.js)
// The renderer calls window.aria.something() — it never touches Node directly
contextBridge.exposeInMainWorld('aria', {

  // Get all active tasks
  getTasks: () => ipcRenderer.invoke('get-tasks'),

  // Send natural language input to be processed by AI
  processInput: (text) => ipcRenderer.invoke('process-input', text),

  // Manually update a task (from UI editing)
  updateTask: (id, updates) => ipcRenderer.invoke('update-task', id, updates),

  // Delete a task
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),

  // Save new task order after drag-and-drop
  reorderTasks: (orderedIds) => ipcRenderer.invoke('reorder-tasks', orderedIds),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Archive
  getArchive: () => ipcRenderer.invoke('get-archive'),
  runArchive: () => ipcRenderer.invoke('run-archive'),

  // Undo last AI action
  undoLast: () => ipcRenderer.invoke('undo-last'),

  // Called by main process every time the window is shown
  onWindowShown: (callback) => ipcRenderer.on('window-shown', callback),

  // Auto-launch at login
  getLoginItem: () => ipcRenderer.invoke('get-login-item'),
  setLoginItem: (enable) => ipcRenderer.invoke('set-login-item', enable),

})
