/**
 * ai.js — Claude API integration using native fetch
 *
 * No external SDK needed. We call the Anthropic REST API directly.
 * This is identical to what the SDK does internally — just without
 * the compatibility issues.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-4-5'

/**
 * Main function — processes any natural language input
 * Returns a structured action for main.js to apply to the database
 */
async function processInput(userText, tasks, settings) {
  const systemPrompt = buildSystemPrompt(settings, tasks)

  let response
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userText }]
      })
    })
  } catch (networkErr) {
    throw new Error('No internet connection. Check your network and try again.')
  }

  // Parse the HTTP response
  const data = await response.json()

  // Handle API-level errors with clean messages
  if (!response.ok) {
    const errMsg = data?.error?.message || ''
    if (response.status === 401) {
      throw new Error('API key is invalid. Go to Settings and paste a fresh key from console.anthropic.com.')
    }
    if (response.status === 429) {
      throw new Error('Too many requests — wait a moment and try again.')
    }
    if (errMsg.toLowerCase().includes('credit') || errMsg.toLowerCase().includes('balance') || errMsg.toLowerCase().includes('billing')) {
      throw new Error('Your Anthropic credits are empty. Go to console.anthropic.com → Billing to add credits.')
    }
    throw new Error(`API error (${response.status}): ${errMsg.slice(0, 120)}`)
  }

  const rawText = data.content?.[0]?.text?.trim() || ''

  // Parse Claude's JSON response
  let result
  try {
    // Strip any accidental markdown code fences Claude might add
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    result = JSON.parse(cleaned)
  } catch {
    // If Claude returned something non-JSON, treat it as a plain answer
    result = { action: 'answer', message: rawText }
  }

  return result
}

/**
 * Build the system prompt with user context + current task list
 */
function buildSystemPrompt(settings, tasks) {
  const taskSummary = buildTaskSummary(tasks)

  return `You are Aria, an intelligent personal task manager assistant for ${settings.userName || 'the user'}.

ABOUT THE USER:
${settings.workContext || 'A professional managing their daily tasks.'}

CURRENT DATE AND TIME: ${new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  })}

YOUR JOB:
Analyze what the user says and return ONE of these JSON actions. Never return anything except valid JSON.

AVAILABLE ACTIONS:

1. CREATE a new task:
{"action":"create","task":{"title":"string","priority":"urgent|high|medium|low","dueDate":"YYYY-MM-DD or null","dueTime":"HH:MM or null","estimatedMinutes":number,"notes":"string","subtasks":[{"title":"string"}]},"confirmation":"one short friendly sentence"}

2. UPDATE an existing task:
{"action":"update","task":{"id":"existing_task_id","title":"string","priority":"urgent|high|medium|low","dueDate":"YYYY-MM-DD or null","dueTime":"HH:MM or null","notes":"string"},"confirmation":"one short friendly sentence"}

3. COMPLETE a task:
{"action":"complete","taskId":"existing_task_id","confirmation":"one short friendly sentence"}

4. CANCEL a task:
{"action":"cancel","taskId":"existing_task_id","confirmation":"one short friendly sentence"}

5. ADD a subtask to existing task:
{"action":"add-subtask","taskId":"existing_task_id","subtask":{"title":"string"},"confirmation":"one short friendly sentence"}

6. ANSWER a question (no task changes):
{"action":"answer","message":"your helpful response here"}

7. CLARIFY (when you genuinely cannot tell which task):
{"action":"clarify","question":"specific question","options":[{"id":"task_id","title":"task title"}]}

8. BULK UPDATE (reprioritize multiple tasks):
{"action":"bulk-update","tasks":[{"id":"task_id","priority":"new_priority","dueDate":"YYYY-MM-DD"}],"confirmation":"one short friendly sentence"}

DUE DATE RULES:
- If the user mentions a specific day or time, use it.
- If the user says "today" or implies it should be done soon with no date, set dueDate to today's date, dueTime to null.
- If the user says "this week" with no specific day, pick a reasonable day (e.g. Friday).
- NEVER set a dueDate in the past. If your calculation would result in a past date, use today instead.
- If you genuinely have no signal about timing at all, still default to today's date with dueTime null — never leave dueDate null for action items.
- Only leave dueDate null for vague "someday" items where the user explicitly implies no urgency.

PRIORITY RULES:
- urgent: needs attention TODAY, drop everything
- high: important, should be done soon (today or tomorrow)
- medium: normal work, this week
- low: someday, no rush

TIME ESTIMATION RULES:
- Quick reply/email: 5-15 minutes
- Short call/meeting: 30-60 minutes
- Document/report: 60-120 minutes
- Presentation/deck: 120-240 minutes
- Complex project task: 120+ minutes

SUBTASK RULES:
- Most tasks should have NO subtasks. Default to no subtasks.
- Only create subtasks when the task is genuinely multi-step AND the steps are distinctly different actions (not just phases of the same action)
- Good example for subtasks: "Prepare investor deck" → [Research comps, Write slides, Design, Practice]
- Bad example (no subtasks needed): "Reply to Marcus email", "Book flight", "Review contract", "Send invoice"
- If in doubt, do NOT add subtasks. The user can always ask for a breakdown later.
- Maximum 4 subtasks per task

DUPLICATE DETECTION:
- If the user tries to create a task very similar to an existing one, use UPDATE instead of CREATE.
- "Similar" means same person, same topic, or same project — even if worded differently.
- Example: existing task "Reply to Marcus about contract" + new input "Send Marcus the contract" → UPDATE, don't create a second Marcus/contract task.
- When updating due to duplicate, mention in the confirmation what you updated.

CURRENT TASK LIST:
${taskSummary}

IMPORTANT: Return ONLY valid JSON. No markdown, no explanation, no code blocks. Just the raw JSON object.`
}

/**
 * Build a concise task summary to include in the AI prompt
 */
function buildTaskSummary(tasks) {
  if (!tasks || tasks.length === 0) return '(No tasks yet)'

  const active = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled')
  const doneToday = tasks.filter(t => {
    if (t.status !== 'done') return false
    return t.completedAt && new Date(t.completedAt).toDateString() === new Date().toDateString()
  })

  let summary = ''

  if (active.length > 0) {
    summary += 'ACTIVE TASKS:\n'
    active.forEach(t => {
      const due = t.dueDate ? ` | Due: ${t.dueDate}${t.dueTime ? ' ' + t.dueTime : ''}` : ''
      const subs = t.subtasks?.length > 0
        ? ` | Subtasks: ${t.subtasks.filter(s => !s.done).length}/${t.subtasks.length} remaining`
        : ''
      summary += `- [${t.id}] "${t.title}" | ${t.priority?.toUpperCase()} | ${t.status}${due}${subs}\n`
      if (t.notes) summary += `  Notes: ${t.notes.slice(0, 100)}\n`
    })
  }

  if (doneToday.length > 0) {
    summary += '\nCOMPLETED TODAY:\n'
    doneToday.forEach(t => { summary += `- "${t.title}"\n` })
  }

  return summary || '(No active tasks)'
}

module.exports = { processInput }
