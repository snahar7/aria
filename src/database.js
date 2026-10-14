/**
 * database.js — All data storage and retrieval
 *
 * We store everything as JSON files on the user's Mac.
 * Two files:
 *   - tasks.json   : active tasks (Today, Upcoming, Someday, Done Today)
 *   - archive.json : completed tasks from previous days
 *   - settings.json: user preferences and API key
 *   - undo.json    : snapshot before last AI action (for undo)
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Store data in the app's user data directory (~/Library/Application Support/aria/)
// This is the Mac-standard location for app data
const DATA_DIR = path.join(app.getPath('userData'), 'data')
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json')
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const UNDO_FILE = path.join(DATA_DIR, 'undo.json')

// Make sure the data directory exists when the module loads
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function readJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

// ─── ID generation ────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// ─── Task operations ──────────────────────────────────────────────────────────

function getTasks() {
  archiveOldCompletedTasks() // Run silently on every read
  return readJSON(TASKS_FILE, [])
}

function createTask(taskData) {
  saveUndoSnapshot()
  const tasks = readJSON(TASKS_FILE, [])
  const now = new Date().toISOString()

  const task = {
    id: generateId(),
    title: taskData.title || 'Untitled task',
    status: taskData.status || 'todo',           // todo | inprogress | done | cancelled
    priority: taskData.priority || 'medium',      // urgent | high | medium | low
    dueDate: taskData.dueDate || null,            // ISO string or null
    dueTime: taskData.dueTime || null,            // "14:30" or null
    estimatedMinutes: taskData.estimatedMinutes || null,
    notes: taskData.notes || '',
    subtasks: taskData.subtasks || [],            // [{ id, title, done }]
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    sortOrder: tasks.length,                      // Used for drag-and-drop ordering
    origin: taskData.origin || null,              // The original text that created this task
    isManuallyOrdered: false
  }

  tasks.push(task)
  writeJSON(TASKS_FILE, tasks)
  return task
}

function updateTask(id, updates) {
  saveUndoSnapshot()
  const tasks = readJSON(TASKS_FILE, [])
  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return null

  tasks[idx] = {
    ...tasks[idx],
    ...updates,
    id: tasks[idx].id,         // Never overwrite the ID
    createdAt: tasks[idx].createdAt, // Never overwrite creation time
    updatedAt: new Date().toISOString()
  }

  writeJSON(TASKS_FILE, tasks)
  return tasks[idx]
}

function completeTask(id) {
  return updateTask(id, {
    status: 'done',
    completedAt: new Date().toISOString()
  })
}

function cancelTask(id) {
  return updateTask(id, { status: 'cancelled' })
}

function deleteTask(id) {
  saveUndoSnapshot()
  const tasks = readJSON(TASKS_FILE, [])
  const filtered = tasks.filter(t => t.id !== id)
  writeJSON(TASKS_FILE, filtered)
}

function addSubtask(taskId, subtaskData) {
  saveUndoSnapshot()
  const tasks = readJSON(TASKS_FILE, [])
  const task = tasks.find(t => t.id === taskId)
  if (!task) return null

  const subtask = {
    id: generateId(),
    title: subtaskData.title || 'Untitled subtask',
    done: false,
    createdAt: new Date().toISOString()
  }

  task.subtasks = task.subtasks || []
  task.subtasks.push(subtask)
  task.updatedAt = new Date().toISOString()

  writeJSON(TASKS_FILE, tasks)
  return subtask
}

function reorderTasks(orderedIds) {
  const tasks = readJSON(TASKS_FILE, [])
  orderedIds.forEach((id, index) => {
    const task = tasks.find(t => t.id === id)
    if (task) {
      task.sortOrder = index
      task.isManuallyOrdered = true
    }
  })
  writeJSON(TASKS_FILE, tasks)
}

// ─── Archive ──────────────────────────────────────────────────────────────────

function archiveOldCompletedTasks() {
  const tasks = readJSON(TASKS_FILE, [])
  const today = new Date().toDateString()

  // Tasks to archive: done/cancelled tasks NOT completed today
  const toArchive = tasks.filter(t => {
    if (t.status !== 'done' && t.status !== 'cancelled') return false
    if (!t.completedAt) return true
    return new Date(t.completedAt).toDateString() !== today
  })

  if (toArchive.length === 0) return

  // Move them to archive
  const archive = readJSON(ARCHIVE_FILE, [])
  archive.push(...toArchive)

  // Keep archive lean: only remember last 200 completed tasks by title (for AI context)
  // Full details kept, but we trim very old ones
  if (archive.length > 500) {
    archive.splice(0, archive.length - 500)
  }

  writeJSON(ARCHIVE_FILE, archive)

  // Remove from active tasks
  const remaining = tasks.filter(t => !toArchive.find(a => a.id === t.id))
  writeJSON(TASKS_FILE, remaining)
}

function getArchive() {
  return readJSON(ARCHIVE_FILE, [])
}

// Return last 30 completed task titles for AI context (keeps AI context lean)
function getRecentCompletedTitles() {
  const archive = readJSON(ARCHIVE_FILE, [])
  return archive
    .slice(-30)
    .map(t => ({ title: t.title, completedAt: t.completedAt }))
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
  return readJSON(SETTINGS_FILE, {
    apiKey: '',
    userName: '',
    workContext: '',
    onboardingDone: false,
    defaultPriority: 'medium'
  })
}

function saveSettings(settings) {
  const current = getSettings()
  writeJSON(SETTINGS_FILE, { ...current, ...settings })
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

function saveUndoSnapshot() {
  const tasks = readJSON(TASKS_FILE, [])
  writeJSON(UNDO_FILE, tasks)
}

function undoLast() {
  const snapshot = readJSON(UNDO_FILE, null)
  if (!snapshot) return false
  // Save current as new undo (so you can redo if needed)
  const current = readJSON(TASKS_FILE, [])
  writeJSON(TASKS_FILE, snapshot)
  writeJSON(UNDO_FILE, current)
  return true
}

module.exports = {
  getTasks,
  createTask,
  updateTask,
  completeTask,
  cancelTask,
  deleteTask,
  addSubtask,
  reorderTasks,
  archiveOldCompletedTasks,
  getArchive,
  getRecentCompletedTitles,
  getSettings,
  saveSettings,
  saveUndoSnapshot,
  undoLast
}
