/**
 * renderer.js — All UI logic
 *
 * This file runs in the "browser" world (the visible panel).
 * It talks to the main process only via window.aria (defined in preload.js).
 * It never touches files or Node.js directly.
 */

// ─── State ────────────────────────────────────────────────────────────────────
let tasks = []
let currentDetailTask = null
let lastAiAction = null
let dragSrcId = null
const collapsedTasks = new Set()
const offlineQueue = []            // inputs queued while offline

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Apply saved theme before anything renders (prevents flash of wrong theme)
  const settings = await window.aria.getSettings()
  applyTheme(settings.theme || 'light')   // default to light mode

  await checkOnboarding()
  await loadTasks()
  bindEvents()
  autoResizeTextarea()

  // Every time the window pops open: reload tasks (picks up date changes), reset panels
  window.aria.onWindowShown(async () => {
    await loadTasks()
    closeDetail()
    closeSettings()
    closeArchive()
    document.getElementById('task-input').focus()
  })
})

async function checkOnboarding() {
  const settings = await window.aria.getSettings()
  // Consider onboarding done if either the flag is set OR an API key already exists
  // (user may have gone straight to Settings and added their key)
  if (!settings.onboardingDone && !settings.apiKey) {
    document.getElementById('onboarding-panel').classList.remove('hidden')
  }
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
document.getElementById('ob-done-btn').addEventListener('click', async () => {
  const name = document.getElementById('ob-name').value.trim()
  const work = document.getElementById('ob-work').value.trim()
  const projects = document.getElementById('ob-projects').value.trim()
  const priority = document.getElementById('ob-priority').value.trim()

  if (!name) {
    document.getElementById('ob-name').focus()
    return
  }

  const workContext = [work, projects, priority].filter(Boolean).join('\n')

  await window.aria.saveSettings({
    userName: name,
    workContext: workContext,
    onboardingDone: true
  })

  document.getElementById('onboarding-panel').classList.add('hidden')
  await loadTasks()
})

// ─── Load & Render Tasks ──────────────────────────────────────────────────────
async function loadTasks() {
  tasks = await window.aria.getTasks()
  renderTaskList()
}

// Re-render detail panel with fresh data if it's currently open
function refreshDetailIfOpen() {
  if (!currentDetailTask) return
  const fresh = tasks.find(t => t.id === currentDetailTask.id)
  if (fresh) {
    currentDetailTask = fresh
    renderDetailPanel(fresh)
  }
}

function renderTaskList() {
  const container = document.getElementById('task-list')
  const today = new Date().toDateString()

  // Categorize tasks
  const todayStart = new Date(); todayStart.setHours(0,0,0,0)
  const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999)
  const in7        = new Date(todayStart); in7.setDate(in7.getDate() + 7)

  const todayTasks = tasks.filter(t => {
    if (t.status === 'done' || t.status === 'cancelled') return false
    if (!t.dueDate) return false
    const d = parseLocalDate(t.dueDate)
    return d <= todayEnd   // today OR overdue
  })

  const upcomingTasks = tasks.filter(t => {
    if (t.status === 'done' || t.status === 'cancelled') return false
    if (!t.dueDate) return false
    const d = parseLocalDate(t.dueDate)
    return d > todayEnd && d <= in7
  })

  const somedayTasks = tasks.filter(t => {
    if (t.status === 'done' || t.status === 'cancelled') return false
    if (t.dueDate) {
      return parseLocalDate(t.dueDate) > in7
    }
    return true
  })

  const doneTodayTasks = tasks.filter(t => {
    if (t.status !== 'done') return false
    return new Date(t.completedAt).toDateString() === today
  })

  // Sort each group by priority then manual order
  const sortByPriority = arr => [...arr].sort((a, b) => {
    if (a.isManuallyOrdered && b.isManuallyOrdered) return a.sortOrder - b.sortOrder
    const p = { urgent: 0, high: 1, medium: 2, low: 3 }
    return (p[a.priority] ?? 2) - (p[b.priority] ?? 2)
  })

  container.innerHTML = ''

  renderSection(container, 'TODAY', sortByPriority(todayTasks), true)
  renderSection(container, 'UPCOMING', sortByPriority(upcomingTasks), true)
  renderSection(container, 'SOMEDAY', sortByPriority(somedayTasks), false)

  // Done Today
  if (doneTodayTasks.length > 0) {
    const sep = document.createElement('hr')
    sep.className = 'done-separator'
    container.appendChild(sep)
    renderSection(container, 'DONE TODAY', doneTodayTasks, false, true)
  }

  const activeTasks = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled')
  if (activeTasks.length === 0) {
    container.appendChild(buildEmptyState())
  }
}

function renderSection(container, title, taskArr, showEmpty, isDone = false) {
  const header = document.createElement('div')
  header.className = 'section-header'
  header.innerHTML = `${title} <span class="section-count">${taskArr.length}</span>`
  container.appendChild(header)

  if (taskArr.length === 0 && showEmpty) {
    const empty = document.createElement('div')
    empty.className = 'empty-section'
    empty.textContent = '—'
    container.appendChild(empty)
    return
  }

  taskArr.forEach(task => {
    container.appendChild(createTaskRow(task, isDone))

    // Render subtasks indented below the parent (all of them, done ones strikethrough)
    if (task.subtasks && task.subtasks.length > 0 && !collapsedTasks.has(task.id)) {
      task.subtasks.forEach((sub, idx) => {
        container.appendChild(createSubtaskRow(sub, task, idx))
      })
    }
  })
}

function createTaskRow(task, isDone = false) {
  const row = document.createElement('div')
  row.className = `task-row${task.status === 'done' ? ' done' : ''}`
  row.dataset.id = task.id
  row.draggable = true

  // Collapse chevron (only shown if task has subtasks)
  if (task.subtasks && task.subtasks.length > 0) {
    const chevron = document.createElement('div')
    chevron.className = `subtask-chevron${collapsedTasks.has(task.id) ? ' collapsed' : ''}`
    chevron.innerHTML = `<svg viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    chevron.title = collapsedTasks.has(task.id) ? 'Show subtasks' : 'Hide subtasks'
    chevron.addEventListener('click', e => {
      e.stopPropagation()
      if (collapsedTasks.has(task.id)) {
        collapsedTasks.delete(task.id)
      } else {
        collapsedTasks.add(task.id)
      }
      renderTaskList()
    })
    row.appendChild(chevron)
  }

  // Status icon
  const statusIcon = document.createElement('div')
  statusIcon.className = 'status-icon'
  statusIcon.innerHTML = getStatusSVG(task.status)
  statusIcon.title = 'Click to mark complete'
  statusIcon.addEventListener('click', e => {
    e.stopPropagation()
    toggleTaskComplete(task.id, task.status)
  })

  // Title
  const titleEl = document.createElement('div')
  titleEl.className = 'task-title'
  titleEl.textContent = task.title

  // Subtask progress pill
  if (task.subtasks && task.subtasks.length > 0) {
    const done = task.subtasks.filter(s => s.done).length
    const pill = document.createElement('span')
    pill.className = 'subtask-progress'
    pill.textContent = `${done}/${task.subtasks.length}`
    row.appendChild(statusIcon)
    row.appendChild(titleEl)
    row.appendChild(pill)
  } else {
    row.appendChild(statusIcon)
    row.appendChild(titleEl)
  }

  // Priority dot
  if (task.priority && task.status !== 'done') {
    const dot = document.createElement('div')
    dot.className = `priority-dot ${task.priority}`
    row.appendChild(dot)
  }

  // Due date chip
  if (task.dueDate && task.status !== 'done') {
    const chip = document.createElement('span')
    chip.className = `due-chip ${getDueDateClass(task.dueDate)}`
    chip.textContent = formatDueDate(task.dueDate, task.dueTime)
    row.appendChild(chip)
  }

  // Click → open detail
  row.addEventListener('click', () => openDetail(task.id))

  // Drag and drop
  row.addEventListener('dragstart', e => {
    dragSrcId = task.id
    row.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
  })
  row.addEventListener('dragend', () => row.classList.remove('dragging'))
  row.addEventListener('dragover', e => {
    e.preventDefault()
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drag-over'))
    row.classList.add('drag-over')
  })
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
  row.addEventListener('drop', async e => {
    e.preventDefault()
    row.classList.remove('drag-over')
    if (dragSrcId && dragSrcId !== task.id) {
      // Reorder tasks
      const allRows = [...document.querySelectorAll('.task-row')]
      const ids = allRows.map(r => r.dataset.id)
      const srcIdx = ids.indexOf(dragSrcId)
      const dstIdx = ids.indexOf(task.id)
      ids.splice(srcIdx, 1)
      ids.splice(dstIdx, 0, dragSrcId)
      tasks = await window.aria.reorderTasks(ids)
      renderTaskList()
    }
    dragSrcId = null
  })

  return row
}

// ─── Subtask Row (indented, appears below parent in main list) ────────────────
function createSubtaskRow(subtask, parentTask, subtaskIdx) {
  const row = document.createElement('div')
  row.className = `task-row subtask-row${subtask.done ? ' done' : ''}`
  row.dataset.subtaskId = subtask.id
  row.dataset.parentId = parentTask.id

  // Tree line / indent indicator
  const indent = document.createElement('div')
  indent.className = 'subtask-tree-line'
  indent.textContent = '└'

  // Status icon — checks off just this subtask
  const statusIcon = document.createElement('div')
  statusIcon.className = 'status-icon'
  statusIcon.innerHTML = subtask.done
    ? getStatusSVG('done')
    : getStatusSVG('todo')
  statusIcon.title = subtask.done ? 'Mark incomplete' : 'Mark complete'
  statusIcon.addEventListener('click', async e => {
    e.stopPropagation()
    const updatedSubs = parentTask.subtasks.map((s, i) =>
      i === subtaskIdx ? { ...s, done: !s.done } : s
    )
    const statusUpdates = computeParentUpdatesAfterSubtaskChange(updatedSubs, parentTask.status)
    parentTask.subtasks = updatedSubs
    if (statusUpdates.status) parentTask.status = statusUpdates.status
    tasks = await window.aria.updateTask(parentTask.id, { subtasks: updatedSubs, ...statusUpdates })
    renderTaskList()
  })

  // Subtask title
  const titleEl = document.createElement('div')
  titleEl.className = 'task-title'
  titleEl.textContent = subtask.title

  row.appendChild(indent)
  row.appendChild(statusIcon)
  row.appendChild(titleEl)

  // Clicking the row also opens the parent detail
  row.addEventListener('click', () => openDetail(parentTask.id))

  return row
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max) + '…'
}

// ─── Subtask auto-status helper ───────────────────────────────────────────────
// Called every time any subtask is toggled (from list view or detail panel).
// Returns the updates object to apply to the parent task.
function computeParentUpdatesAfterSubtaskChange(updatedSubs, currentParentStatus) {
  const total = updatedSubs.length
  const doneCount = updatedSubs.filter(s => s.done).length

  if (total === 0) return {}   // no subtasks — don't touch parent status

  if (doneCount === total) {
    // All done → complete the parent
    return { status: 'done', completedAt: new Date().toISOString() }
  }

  if (doneCount > 0 && currentParentStatus === 'todo') {
    // Some done, parent was untouched → move to In Progress
    return { status: 'inprogress' }
  }

  if (doneCount === 0 && currentParentStatus === 'done') {
    // All unchecked again → revert parent from done back to In Progress
    return { status: 'inprogress', completedAt: null }
  }

  if (doneCount === 0 && currentParentStatus === 'inprogress') {
    // All unchecked → revert back to To Do
    return { status: 'todo', completedAt: null }
  }

  return {}  // no status change needed
}

// ─── Task Complete Toggle ──────────────────────────────────────────────────────
async function toggleTaskComplete(id, currentStatus) {
  if (currentStatus === 'done') {
    tasks = await window.aria.updateTask(id, { status: 'todo', completedAt: null })
  } else {
    // Check for incomplete subtasks
    const task = tasks.find(t => t.id === id)
    const hasIncompleteSubs = task?.subtasks?.some(s => !s.done)
    if (hasIncompleteSubs) {
      showResponse(`This task has incomplete subtasks — open it to check them off, or mark it done anyway.`, 'info', false)
    }
    tasks = await window.aria.updateTask(id, {
      status: 'done',
      completedAt: new Date().toISOString()
    })
  }
  renderTaskList()
}

// ─── Input Handling ───────────────────────────────────────────────────────────
function bindEvents() {
  const input = document.getElementById('task-input')
  const sendBtn = document.getElementById('send-btn')

  sendBtn.addEventListener('click', handleSubmit)

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  })

  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable

    if (e.key === 'Escape') {
      if (document.getElementById('archive-panel').classList.contains('open')) {
        closeArchive()
      } else if (document.getElementById('settings-panel').classList.contains('open')) {
        closeSettings()
      } else if (document.getElementById('detail-panel').classList.contains('open')) {
        closeDetail()
      } else {
        input.focus()
      }
      return
    }

    // N or / → focus input (only when not already typing somewhere)
    if ((e.key === 'n' || e.key === '/') && !isTyping) {
      e.preventDefault()
      input.focus()
      return
    }

    // Cmd+Z → undo last AI action (only when not typing)
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !isTyping) {
      e.preventDefault()
      document.getElementById('undo-btn').click()
      return
    }
  })

  // Focus input whenever the window becomes active
  window.addEventListener('focus', () => {
    if (!document.getElementById('detail-panel').classList.contains('open') &&
        !document.getElementById('settings-panel').classList.contains('open')) {
      input.focus()
    }
  })

  // Back buttons
  document.getElementById('back-btn').addEventListener('click', closeDetail)
  document.getElementById('settings-btn').addEventListener('click', openSettings)
  document.getElementById('settings-back-btn').addEventListener('click', closeSettings)

  // Settings save
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings)

  // Theme toggle
  document.getElementById('theme-btn').addEventListener('click', toggleTheme)

  // Archive panel
  document.getElementById('archive-btn').addEventListener('click', openArchive)
  document.getElementById('archive-back-btn').addEventListener('click', closeArchive)
  document.getElementById('archive-search').addEventListener('input', async e => {
    const archive = await window.aria.getArchive()
    renderArchivePanel(archive, e.target.value)
  })

  // Export
  document.getElementById('export-btn').addEventListener('click', exportTasks)

  // Reset
  document.getElementById('reset-btn').addEventListener('click', async () => {
    if (confirm('This will delete ALL your tasks and settings. Are you sure?')) {
      await window.aria.saveSettings({ onboardingDone: false, apiKey: '', model: '', userName: '', workContext: '' })
      location.reload()
    }
  })

  // Undo
  document.getElementById('undo-btn').addEventListener('click', async () => {
    tasks = await window.aria.undoLast()
    renderTaskList()
    showResponse('Done — last action undone.', 'success', false)
  })
}

async function handleSubmit() {
  const input = document.getElementById('task-input')
  const text = input.value.trim()
  if (!text) return

  const settings = await window.aria.getSettings()
  if (!settings.apiKey) {
    showResponse('Add your Claude API key in Settings first.', 'error', false)
    openSettings()
    return
  }

  // Quick client-side duplicate check before hitting the API
  const activeTitles = tasks
    .filter(t => t.status !== 'done' && t.status !== 'cancelled')
    .map(t => t.title.toLowerCase())
  const inputLower = text.toLowerCase()
  const closeMatch = activeTitles.find(title => {
    // Check if input contains most of an existing task title (>60% word overlap)
    const titleWords = title.split(/\s+/).filter(w => w.length > 3)
    const inputWords = inputLower.split(/\s+/)
    const matches = titleWords.filter(w => inputWords.some(iw => iw.includes(w) || w.includes(iw)))
    return titleWords.length > 0 && matches.length / titleWords.length >= 0.6
  })

  if (closeMatch) {
    // Let the AI handle it — it will update rather than create — but warn the user
    showResponse(`Looks related to an existing task — checking if this is an update…`, 'info', false)
  }

  input.value = ''
  resizeTextarea(input)
  setLoading(true)
  if (!closeMatch) showResponse('Thinking...', 'thinking', false)
  hideClarify()

  const result = await window.aria.processInput(text)
  setLoading(false)

  if (result.error === 'no-api-key') {
    showResponse('Add your Claude API key in Settings.', 'error', false)
    openSettings()
    return
  }

  // Network/API unreachable → queue the input, don't lose it
  if (result.error === 'ai-error' && result.message && result.message.toLowerCase().includes('internet')) {
    offlineQueue.push(text)
    updateOfflineBanner()
    showResponse('No internet — input saved. Will process when reconnected.', 'info', false)
    return
  }

  if (result.error) {
    showResponse(`Error: ${result.message}`, 'error', false)
    return
  }

  const { result: aiResult } = result
  tasks = result.tasks

  if (aiResult.action === 'clarify') {
    showClarify(aiResult)
    showResponse(aiResult.question, 'info', false)
    return
  }

  if (aiResult.action === 'answer') {
    showResponse(aiResult.message, 'info', false)
    return
  }

  // Show confirmation + undo button for task-modifying actions
  showResponse(aiResult.confirmation || 'Done.', 'success', true)
  lastAiAction = aiResult

  renderTaskList()
}

// ─── Clarify UI ───────────────────────────────────────────────────────────────
function showClarify(aiResult) {
  const container = document.getElementById('clarify-container')
  container.classList.remove('hidden')
  container.innerHTML = ''

  const div = document.createElement('div')
  div.className = 'clarify-options'
  div.innerHTML = `<div class="clarify-q">${aiResult.question}</div>`

  aiResult.options?.forEach(opt => {
    const btn = document.createElement('button')
    btn.className = 'clarify-option'
    btn.textContent = opt.title
    btn.addEventListener('click', async () => {
      hideClarify()
      const input = document.getElementById('task-input')
      input.value = opt.title
      await handleSubmit()
    })
    div.appendChild(btn)
  })

  container.appendChild(div)
}

function hideClarify() {
  const container = document.getElementById('clarify-container')
  container.classList.add('hidden')
  container.innerHTML = ''
}

// ─── Response Bar ──────────────────────────────────────────────────────────────
function showResponse(message, type = 'success', showUndo = false) {
  const bar = document.getElementById('ai-response')
  const text = document.getElementById('ai-response-text')
  const dot = bar.querySelector('.dot')
  const undoBtn = document.getElementById('undo-btn')

  bar.classList.remove('hidden')
  text.textContent = message
  dot.className = `dot ${type === 'error' ? 'error' : type === 'thinking' ? 'thinking' : ''}`
  undoBtn.classList.toggle('hidden', !showUndo)

  // Auto-hide after 5 seconds (not for thinking state)
  if (type !== 'thinking') {
    clearTimeout(bar._timer)
    bar._timer = setTimeout(() => {
      bar.classList.add('hidden')
      undoBtn.classList.add('hidden')
    }, 5000)
  }
}

// ─── Detail Panel ──────────────────────────────────────────────────────────────
function openDetail(taskId) {
  currentDetailTask = tasks.find(t => t.id === taskId)
  if (!currentDetailTask) return
  renderDetailPanel(currentDetailTask)
  document.getElementById('detail-panel').classList.add('open')
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open')
  currentDetailTask = null
}

// Show a brief "Saved" flash in the detail header
function flashSaved() {
  const el = document.getElementById('detail-status-display')
  const prev = el.textContent
  el.textContent = '✓ Saved'
  el.style.color = 'var(--done)'
  clearTimeout(el._t)
  el._t = setTimeout(() => {
    el.textContent = prev
    el.style.color = ''
  }, 1500)
}

// Helper: save a field and refresh
async function saveDetailField(taskId, updates) {
  tasks = await window.aria.updateTask(taskId, updates)
  renderTaskList()
  flashSaved()
}

function renderDetailPanel(task) {
  const content = document.getElementById('detail-content')
  const statusDisplay = document.getElementById('detail-status-display')
  statusDisplay.textContent = formatStatus(task.status)

  content.innerHTML = ''

  // Title (editable — single line input, not textarea)
  const title = document.createElement('input')
  title.id = 'detail-title'
  title.type = 'text'
  title.value = task.title
  title.addEventListener('blur', async () => {
    const newTitle = title.value.trim()
    if (newTitle && newTitle !== task.title) {
      task.title = newTitle
      await saveDetailField(task.id, { title: newTitle })
    }
  })
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur() }
  })
  content.appendChild(title)

  // Fields
  const fields = document.createElement('div')
  fields.className = 'detail-fields'

  // Status
  fields.appendChild(makeSelectField('Status', 'status', task.status, [
    { value: 'todo', label: '○ To Do' },
    { value: 'inprogress', label: '◐ In Progress' },
    { value: 'done', label: '✓ Done' },
    { value: 'cancelled', label: '⊘ Cancelled' }
  ], async val => {
    task.status = val
    const updates = { status: val }
    if (val === 'done') updates.completedAt = new Date().toISOString()
    else updates.completedAt = null
    await saveDetailField(task.id, updates)
    document.getElementById('detail-status-display').textContent = formatStatus(val)
  }))

  // Priority
  fields.appendChild(makeSelectField('Priority', 'priority', task.priority, [
    { value: 'urgent', label: '!! Urgent' },
    { value: 'high', label: '!  High' },
    { value: 'medium', label: '–  Medium' },
    { value: 'low', label: '↓  Low' }
  ], async val => {
    task.priority = val
    await saveDetailField(task.id, { priority: val, isManuallyOrdered: true })
  }))

  // Due date
  fields.appendChild(makeDateField(task, async (date, time) => {
    task.dueDate = date
    task.dueTime = time
    await saveDetailField(task.id, { dueDate: date, dueTime: time })
  }))

  // Estimated time (read only — set by AI)
  if (task.estimatedMinutes) {
    const row = document.createElement('div')
    row.className = 'detail-field'
    row.innerHTML = `<span class="field-label">Est. Time</span><span class="field-value">${formatEstimate(task.estimatedMinutes)}</span>`
    fields.appendChild(row)
  }

  // Created at
  const created = document.createElement('div')
  created.className = 'detail-field'
  created.innerHTML = `<span class="field-label">Created</span><span class="field-value">${formatCreatedAt(task.createdAt)}</span>`
  fields.appendChild(created)

  content.appendChild(fields)

  // Origin trace
  if (task.origin) {
    const origin = document.createElement('div')
    origin.className = 'origin-trace'
    origin.textContent = `💬 "${task.origin}"`
    content.appendChild(origin)
  }

  // Notes
  const notesTitle = document.createElement('div')
  notesTitle.className = 'detail-section-title'
  notesTitle.textContent = 'Notes'
  content.appendChild(notesTitle)

  const notes = document.createElement('textarea')
  notes.id = 'detail-notes'
  notes.rows = 3
  notes.placeholder = 'Add notes...'
  notes.value = task.notes || ''
  notes.addEventListener('blur', async () => {
    if (notes.value !== task.notes) {
      task.notes = notes.value
      await saveDetailField(task.id, { notes: notes.value })
    }
  })
  content.appendChild(notes)

  // Subtasks
  if (task.subtasks && task.subtasks.length > 0) {
    const subsTitle = document.createElement('div')
    subsTitle.className = 'detail-section-title'
    subsTitle.textContent = 'Subtasks'
    content.appendChild(subsTitle)

    const subList = document.createElement('div')
    subList.className = 'subtask-list'

    task.subtasks.forEach((sub, idx) => {
      const item = document.createElement('div')
      item.className = 'subtask-item'

      const check = document.createElement('div')
      check.className = `subtask-check${sub.done ? ' checked' : ''}`
      check.addEventListener('click', async () => {
        const updatedSubs = task.subtasks.map((s, i) =>
          i === idx ? { ...s, done: !s.done } : s
        )
        const statusUpdates = computeParentUpdatesAfterSubtaskChange(updatedSubs, task.status)
        task.subtasks = updatedSubs
        if (statusUpdates.status) task.status = statusUpdates.status
        currentDetailTask = task
        await saveDetailField(task.id, { subtasks: updatedSubs, ...statusUpdates })
        // Re-render the status display in the detail header
        document.getElementById('detail-status-display').textContent = formatStatus(task.status)
        renderDetailPanel(task)
      })

      const subTitle = document.createElement('span')
      subTitle.className = `subtask-title${sub.done ? ' done' : ''}`
      subTitle.textContent = sub.title

      item.appendChild(check)
      item.appendChild(subTitle)
      subList.appendChild(item)
    })

    content.appendChild(subList)
  }

  // Add subtask input
  const addSubRow = document.createElement('div')
  addSubRow.className = 'add-subtask-row'
  const addSubInput = document.createElement('input')
  addSubInput.className = 'add-subtask-input'
  addSubInput.placeholder = '+ Add subtask (press Enter)'

  const commitSubtask = async () => {
    const newTitle = addSubInput.value.trim()
    if (!newTitle) return
    addSubInput.value = ''
    const updatedSubs = [...(task.subtasks || []), {
      id: Date.now().toString(), title: newTitle, done: false,
      createdAt: new Date().toISOString()
    }]
    task.subtasks = updatedSubs
    currentDetailTask = task
    await saveDetailField(task.id, { subtasks: updatedSubs })
    renderDetailPanel(task)
  }

  addSubInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitSubtask() }
    if (e.key === 'Escape') { addSubInput.value = ''; addSubInput.blur() }
  })
  addSubRow.appendChild(addSubInput)
  content.appendChild(addSubRow)

  // Delete button
  const deleteBtn = document.createElement('button')
  deleteBtn.id = 'delete-task-btn'
  deleteBtn.textContent = 'Delete Task'
  deleteBtn.addEventListener('click', async () => {
    if (confirm(`Delete "${task.title}"?`)) {
      tasks = await window.aria.deleteTask(task.id)
      closeDetail()
      renderTaskList()
    }
  })
  content.appendChild(deleteBtn)
}

// ─── Settings Panel ────────────────────────────────────────────────────────────
async function openSettings() {
  const settings = await window.aria.getSettings()
  document.getElementById('settings-api-key').value = settings.apiKey || ''
  document.getElementById('settings-model').value = settings.model || ''
  document.getElementById('settings-name').value = settings.userName || ''
  document.getElementById('settings-context').value = settings.workContext || ''
  const launchAtLogin = await window.aria.getLoginItem()
  document.getElementById('settings-launch-login').checked = launchAtLogin
  document.getElementById('settings-panel').classList.add('open')
}

function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open')
}

async function saveSettings() {
  const apiKey      = document.getElementById('settings-api-key').value.trim()
  const model       = document.getElementById('settings-model').value.trim()
  const userName    = document.getElementById('settings-name').value.trim()
  const workContext = document.getElementById('settings-context').value.trim()
  const launchAtLogin = document.getElementById('settings-launch-login').checked

  await window.aria.saveSettings({ apiKey, model, userName, workContext })
  await window.aria.setLoginItem(launchAtLogin)
  closeSettings()
  showResponse('Settings saved.', 'success', false)
}

// ─── Archive Panel ────────────────────────────────────────────────────────────
async function openArchive() {
  const archive = await window.aria.getArchive()
  renderArchivePanel(archive)
  document.getElementById('archive-panel').classList.add('open')
}

function closeArchive() {
  document.getElementById('archive-panel').classList.remove('open')
}

function renderArchivePanel(archive, filterText = '') {
  const list = document.getElementById('archive-list')
  const countEl = document.getElementById('archive-count')
  list.innerHTML = ''

  const filtered = filterText
    ? archive.filter(t => t.title.toLowerCase().includes(filterText.toLowerCase()))
    : archive

  countEl.textContent = `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`

  if (filtered.length === 0) {
    list.innerHTML = `<div class="archive-empty">${filterText ? 'No matching tasks.' : 'No archived tasks yet.\nCompleted tasks appear here after midnight.'}</div>`
    return
  }

  // Group by relative date
  const groups = {}
  const todayStr    = new Date().toDateString()
  const yesterdayStr = new Date(Date.now() - 86400000).toDateString()
  const weekAgo     = Date.now() - 7 * 86400000

  ;[...filtered].reverse().forEach(t => {
    const d = t.completedAt ? new Date(t.completedAt) : new Date(t.updatedAt || t.createdAt)
    let label
    if (d.toDateString() === todayStr)         label = 'Today'
    else if (d.toDateString() === yesterdayStr) label = 'Yesterday'
    else if (d.getTime() >= weekAgo)            label = 'This Week'
    else label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

    if (!groups[label]) groups[label] = []
    groups[label].push(t)
  })

  Object.entries(groups).forEach(([label, items]) => {
    const group = document.createElement('div')
    group.className = 'archive-date-group'

    const header = document.createElement('div')
    header.className = 'archive-date-header'
    header.textContent = label
    group.appendChild(header)

    items.forEach(t => {
      const row = document.createElement('div')
      row.className = 'archive-item'

      const dot = document.createElement('div')
      dot.className = `archive-priority-dot priority-dot ${t.priority || 'medium'}`

      const title = document.createElement('div')
      title.className = 'archive-item-title'
      title.textContent = t.title

      const meta = document.createElement('div')
      meta.className = 'archive-item-meta'
      const d = t.completedAt ? new Date(t.completedAt) : null
      meta.textContent = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

      row.appendChild(dot)
      row.appendChild(title)
      row.appendChild(meta)
      group.appendChild(row)
    })

    list.appendChild(group)
  })
}

// ─── Offline Queue ────────────────────────────────────────────────────────────
function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner')
  const countEl = document.getElementById('offline-count')
  if (offlineQueue.length === 0) {
    banner.classList.add('hidden')
  } else {
    banner.classList.remove('hidden')
    countEl.textContent = `${offlineQueue.length} queued`
  }
}

async function processOfflineQueue() {
  if (offlineQueue.length === 0) return
  showResponse(`Reconnected — processing ${offlineQueue.length} queued item${offlineQueue.length > 1 ? 's' : ''}…`, 'thinking', false)

  while (offlineQueue.length > 0) {
    const text = offlineQueue[0]
    try {
      setLoading(true)
      const result = await window.aria.processInput(text)
      setLoading(false)
      if (!result.error) {
        offlineQueue.shift()
        if (result.tasks) { tasks = result.tasks; renderTaskList() }
        updateOfflineBanner()
      } else {
        break  // still failing — stop and wait
      }
    } catch {
      setLoading(false)
      break
    }
  }

  if (offlineQueue.length === 0) {
    showResponse('All queued tasks processed.', 'success', false)
  }
  updateOfflineBanner()
}

// Listen for browser online/offline events
window.addEventListener('online',  () => processOfflineQueue())
window.addEventListener('offline', () => updateOfflineBanner())

// ─── Export ────────────────────────────────────────────────────────────────────
async function exportTasks() {
  const allTasks = await window.aria.getTasks()
  const archive = await window.aria.getArchive()
  const data = { tasks: allTasks, archive, exportedAt: new Date().toISOString() }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `aria-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Helper: Field builders ────────────────────────────────────────────────────
function makeSelectField(label, name, value, options, onChange) {
  const row = document.createElement('div')
  row.className = 'detail-field'

  const lbl = document.createElement('span')
  lbl.className = 'field-label'
  lbl.textContent = label

  const sel = document.createElement('select')
  sel.className = 'field-select'
  options.forEach(opt => {
    const o = document.createElement('option')
    o.value = opt.value
    o.textContent = opt.label
    if (opt.value === value) o.selected = true
    sel.appendChild(o)
  })
  sel.addEventListener('change', () => onChange(sel.value))

  row.appendChild(lbl)
  row.appendChild(sel)
  return row
}

function makeDateField(task, onChange) {
  const row = document.createElement('div')
  row.className = 'detail-field'

  const lbl = document.createElement('span')
  lbl.className = 'field-label'
  lbl.textContent = 'Due Date'

  const dateInput = document.createElement('input')
  dateInput.className = 'field-input'
  dateInput.type = 'date'
  dateInput.value = task.dueDate || ''
  dateInput.style.width = '120px'

  const timeInput = document.createElement('input')
  timeInput.className = 'field-input'
  timeInput.type = 'time'
  timeInput.value = task.dueTime || ''
  timeInput.style.width = '90px'
  timeInput.style.marginLeft = '6px'

  const handler = () => onChange(dateInput.value || null, timeInput.value || null)
  dateInput.addEventListener('change', handler)
  timeInput.addEventListener('change', handler)

  row.appendChild(lbl)
  row.appendChild(dateInput)
  row.appendChild(timeInput)
  return row
}

// ─── Date parsing ─────────────────────────────────────────────────────────────
// IMPORTANT: new Date("2026-03-26") parses as UTC midnight, which lands on the
// previous day in timezones east of UTC (e.g. India = UTC+5:30).
// Always use this function when working with YYYY-MM-DD date strings.
function parseLocalDate(dateStr) {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)   // local midnight — no timezone shift
}

// ─── Helper: Formatting ────────────────────────────────────────────────────────
function getStatusSVG(status) {
  const s = { stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none' }
  switch (status) {
    case 'todo':
      return `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="var(--text-3)" stroke-width="1.2"/></svg>`
    case 'inprogress':
      return `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="var(--accent)" stroke-width="1.2"/><path d="M7 1.5A5.5 5.5 0 0 1 12.5 7H7V1.5Z" fill="var(--accent)"/></svg>`
    case 'done':
      return `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" fill="var(--done)" stroke="var(--done)" stroke-width="1.2"/><path d="M4.5 7l2 2 3-3" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    case 'cancelled':
      return `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="var(--text-3)" stroke-width="1.2"/><path d="M5 5l4 4M9 5l-4 4" stroke="var(--text-3)" stroke-width="1.2" stroke-linecap="round"/></svg>`
    default:
      return `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="var(--text-3)" stroke-width="1.2"/></svg>`
  }
}

function getDueDateClass(dueDate) {
  if (!dueDate) return ''
  const d = parseLocalDate(dueDate)
  const today = new Date(); today.setHours(0,0,0,0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const dayAfter  = new Date(tomorrow); dayAfter.setDate(dayAfter.getDate() + 1)

  if (d < today)              return 'overdue'
  if (d < tomorrow)           return 'today'
  if (d < dayAfter)           return 'tomorrow'
  return ''
}

function isOverdue(dueDate) {
  if (!dueDate) return false
  const today = new Date(); today.setHours(0,0,0,0)
  return parseLocalDate(dueDate) < today
}

function formatDueDate(dueDate, dueTime) {
  if (!dueDate) return ''
  const d        = parseLocalDate(dueDate)
  const today    = new Date(); today.setHours(0,0,0,0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)

  let label = ''
  if (d < today)                              label = 'Overdue'
  else if (d.toDateString() === today.toDateString())    label = 'Today'
  else if (d.toDateString() === tomorrow.toDateString()) label = 'Tomorrow'
  else label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (dueTime) label += ` ${formatTime(dueTime)}`
  return label
}

function formatTime(timeStr) {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')}${ampm}`
}

function formatEstimate(mins) {
  if (!mins) return ''
  if (mins < 60) return `~${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`
}

function formatStatus(status) {
  return { todo: '○ To Do', inprogress: '◐ In Progress', done: '✓ Done', cancelled: '⊘ Cancelled' }[status] || status
}

function formatCreatedAt(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Smart empty state ────────────────────────────────────────────────────────
function buildEmptyState() {
  const hour = new Date().getHours()
  let icon, title, sub

  if (hour < 9) {
    icon = '🌅'
    title = 'Morning clear'
    sub = 'Nothing on your plate yet.\nWhat are you working on today?'
  } else if (hour < 12) {
    icon = '☀️'
    title = 'All clear'
    sub = 'No active tasks. Type anything to\nget Aria to create or track something.'
  } else if (hour < 17) {
    icon = '✅'
    title = 'You\'re all caught up'
    sub = 'No tasks remaining. Add something new\nor ask "what should I focus on?"'
  } else if (hour < 20) {
    icon = '🌆'
    title = 'Clean slate for tomorrow'
    sub = 'Nothing left today. Want to plan\nwhat\'s on deck for tomorrow?'
  } else {
    icon = '🌙'
    title = 'All done for today'
    sub = 'Great work. Any last things to\ncapture before you wind down?'
  }

  const el = document.createElement('div')
  el.className = 'empty-state'
  el.innerHTML = `
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${title}</div>
    <div class="empty-state-sub">${sub}</div>
  `
  return el
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const btn = document.getElementById('theme-btn')
  if (btn) btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
}

async function toggleTheme() {
  const settings = await window.aria.getSettings()
  const next = (settings.theme || 'dark') === 'dark' ? 'light' : 'dark'
  await window.aria.saveSettings({ theme: next })
  applyTheme(next)
}

// ─── UI Helpers ────────────────────────────────────────────────────────────────
function setLoading(isLoading) {
  const btn = document.getElementById('send-btn')
  btn.disabled = isLoading
  if (isLoading) {
    btn.innerHTML = `<div class="spinner" style="width:12px;height:12px;border-width:1.5px;"></div>`
  } else {
    btn.innerHTML = `<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  }
}

function autoResizeTextarea() {
  const ta = document.getElementById('task-input')
  ta.addEventListener('input', () => resizeTextarea(ta))
}

function resizeTextarea(ta) {
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 80) + 'px'
}
