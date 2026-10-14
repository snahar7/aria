const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron')
const path = require('path')
const { processInput } = require('./ai')
const db = require('./database')

// Keep references so they don't get garbage collected
let tray = null
let win = null

// Allow only one instance of the app
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.whenReady().then(() => {
  // Hide from Dock AFTER app is ready (important for macOS 13+)
  if (app.dock) app.dock.hide()
  createTray()
  createWindow()
})

// ─── Tray (the menu bar icon) ────────────────────────────────────────────────

function createTray() {
  // Use a tiny blank image as the tray icon base, then show "A" as text
  const blankIcon = nativeImage.createEmpty()
  tray = new Tray(blankIcon)
  tray.setTitle('A')
  tray.setToolTip('Aria — AI Task Manager')

  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Aria', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit Aria', click: () => app.quit() }
    ])
    tray.popUpContextMenu(menu)
  })
}

// ─── Window (the floating panel) ─────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    frame: false,           // No title bar — we style our own header
    transparent: false,
    resizable: false,
    skipTaskbar: true,      // Don't show in app switcher
    alwaysOnTop: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false  // Security: renderer can't access Node directly
    }
  })

  win.loadFile(path.join(__dirname, 'index.html'))

  // Hide when user clicks outside the window.
  // Small delay so clicks on buttons inside the window don't trigger blur first.
  win.on('blur', () => {
    setTimeout(() => {
      if (win && win.isVisible() && !win.isFocused()) {
        win.hide()
      }
    }, 150)
  })

  // Tell the renderer to reset panels every time the window is shown
  win.on('show', () => {
    win.webContents.send('window-shown')
  })
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    showWindow()
  }
}

function showWindow() {
  if (!win) return

  // Position window near the tray icon
  const trayBounds = tray.getBounds()
  const windowBounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })

  // Center horizontally on tray icon, drop just below menu bar
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)
  const y = Math.round(trayBounds.y + trayBounds.height + 4)

  // Make sure window doesn't go off screen
  const clampedX = Math.min(Math.max(x, display.bounds.x + 8), display.bounds.x + display.bounds.width - windowBounds.width - 8)

  win.setPosition(clampedX, y, false)
  win.show()
  win.focus()
}

// ─── IPC Handlers (renderer talks to main process through these) ──────────────

// Get all tasks
ipcMain.handle('get-tasks', async () => {
  return db.getTasks()
})

// Process natural language input through AI
ipcMain.handle('process-input', async (event, text) => {
  try {
    const tasks = db.getTasks()
    const settings = db.getSettings()

    if (!settings.apiKey) {
      return { error: 'no-api-key', message: 'Please add your Claude API key in Settings first.' }
    }

    const result = await processInput(text, tasks, settings)

    // Apply AI's decision to the database
    if (result.action === 'create') {
      db.createTask({ ...result.task, origin: text })  // store original text for trace
    } else if (result.action === 'update') {
      db.updateTask(result.task.id, result.task)
    } else if (result.action === 'complete') {
      db.completeTask(result.taskId)
    } else if (result.action === 'cancel') {
      db.cancelTask(result.taskId)
    } else if (result.action === 'add-subtask') {
      db.addSubtask(result.taskId, result.subtask)
    } else if (result.action === 'bulk-update') {
      result.tasks.forEach(t => db.updateTask(t.id, t))
    } else if (result.action === 'clarify') {
      // No DB change — just return the clarification to the UI
    }

    return { success: true, result, tasks: db.getTasks() }
  } catch (err) {
    console.error('process-input error:', err)
    return { error: 'ai-error', message: err.message }
  }
})

// Manual task update (from UI editing)
ipcMain.handle('update-task', async (event, id, updates) => {
  db.updateTask(id, updates)
  return db.getTasks()
})

// Manual task deletion
ipcMain.handle('delete-task', async (event, id) => {
  db.deleteTask(id)
  return db.getTasks()
})

// Reorder tasks (drag and drop)
ipcMain.handle('reorder-tasks', async (event, orderedIds) => {
  db.reorderTasks(orderedIds)
  return db.getTasks()
})

// Get settings
ipcMain.handle('get-settings', async () => {
  return db.getSettings()
})

// Save settings
ipcMain.handle('save-settings', async (event, settings) => {
  db.saveSettings(settings)
  return { success: true }
})

// Get archived tasks
ipcMain.handle('get-archive', async () => {
  return db.getArchive()
})

// Run midnight archive (move completed tasks from previous days to archive)
ipcMain.handle('run-archive', async () => {
  db.archiveOldCompletedTasks()
  return db.getTasks()
})

// Undo last AI action
ipcMain.handle('undo-last', async () => {
  db.undoLast()
  return db.getTasks()
})

// Auto-launch at login
ipcMain.handle('get-login-item', async () => {
  return app.getLoginItemSettings().openAtLogin
})

ipcMain.handle('set-login-item', async (event, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable })
  return true
})
