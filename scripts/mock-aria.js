// A fake window.aria (the preload API) so the renderer can run in a plain browser
// for screenshots. Sample data only; no network calls.
(() => {
  const today = new Date()
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }
  const now = new Date().toISOString()
  let n = 0
  const mk = (t) => ({ id: 't' + (++n), status: 'todo', notes: '', subtasks: [], createdAt: now, updatedAt: now, completedAt: null, sortOrder: n, origin: null, isManuallyOrdered: false, dueTime: null, estimatedMinutes: 30, ...t })
  let tasks = [
    mk({ title: 'Reply to Priya about the Q4 budget', priority: 'urgent', dueDate: iso(today), dueTime: '11:00', estimatedMinutes: 15 }),
    mk({ title: 'Prepare customer onboarding deck', priority: 'high', dueDate: iso(today), estimatedMinutes: 120, subtasks: [
      { id: 's1', title: 'Collect three customer quotes', done: true },
      { id: 's2', title: 'Draft the 10 slides', done: false },
      { id: 's3', title: 'Dry run with the team', done: false } ] }),
    mk({ title: 'Book flights for the offsite', priority: 'medium', dueDate: plus(2), estimatedMinutes: 20 }),
    mk({ title: 'Review the vendor contract', priority: 'medium', dueDate: plus(4), estimatedMinutes: 45 }),
    mk({ title: 'Read "Working in Public"', priority: 'low', dueDate: null }),
    mk({ title: 'Send weekly update', priority: 'medium', dueDate: iso(today), status: 'done', completedAt: now }),
  ]
  let settings = { apiKey: 'demo', model: '', userName: 'Sam', workContext: '', onboardingDone: true, defaultPriority: 'medium', theme: window.__ARIA_THEME || 'light' }
  const clone = (x) => JSON.parse(JSON.stringify(x))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // Canned "AI": turn a sentence into a task.
  function fakeAI(text) {
    const lower = text.toLowerCase()
    if (/maya|follow up|call/.test(lower)) {
      return { action: 'create', task: { title: 'Call Maya to follow up on the pilot', priority: 'high', dueDate: plus(1), dueTime: '10:00', estimatedMinutes: 30 }, confirmation: 'Added a call with Maya tomorrow at 10:00.' }
    }
    if (/launch|plan/.test(lower)) {
      return { action: 'create', task: { title: 'Plan the product launch', priority: 'high', dueDate: plus(3), estimatedMinutes: 180, subtasks: [
        { title: 'Write the announcement' }, { title: 'Record a 60-second demo' }, { title: 'Line up 5 early users' } ] }, confirmation: 'Planned the launch with 3 steps, due Friday.' }
    }
    return { action: 'create', task: { title: text.charAt(0).toUpperCase() + text.slice(1), priority: 'medium', dueDate: iso(today), estimatedMinutes: 30 }, confirmation: 'Added for today.' }
  }

  window.aria = {
    getTasks: async () => clone(tasks),
    processInput: async (text) => {
      await wait(1100)
      const result = fakeAI(text)
      if (result.action === 'create') {
        const subs = (result.task.subtasks || []).map((s, i) => ({ id: 'n' + i, title: s.title, done: false }))
        tasks.push(mk({ ...result.task, subtasks: subs, origin: text }))
      }
      return { success: true, result, tasks: clone(tasks) }
    },
    updateTask: async (id, u) => { tasks = tasks.map((t) => (t.id === id ? { ...t, ...u } : t)); return clone(tasks) },
    deleteTask: async (id) => { tasks = tasks.filter((t) => t.id !== id); return clone(tasks) },
    reorderTasks: async () => clone(tasks),
    getSettings: async () => clone(settings),
    saveSettings: async (s) => { settings = { ...settings, ...s }; return { success: true } },
    getArchive: async () => [],
    runArchive: async () => clone(tasks),
    undoLast: async () => clone(tasks),
    onWindowShown: () => {},
    getLoginItem: async () => false,
    setLoginItem: async () => true,
  }
})()
