const test = require('node:test')
const assert = require('node:assert')
const { processInput, resolveModel, DEFAULT_MODEL } = require('../src/ai')

test('default model is claude-opus-4-5', () => {
  delete process.env.ARIA_MODEL
  assert.strictEqual(DEFAULT_MODEL, 'claude-opus-4-5')
  assert.strictEqual(resolveModel({}), 'claude-opus-4-5')
})

test('settings.model overrides env, env overrides default', () => {
  process.env.ARIA_MODEL = 'claude-from-env'
  assert.strictEqual(resolveModel({}), 'claude-from-env')
  assert.strictEqual(resolveModel({ model: ' claude-from-settings ' }), 'claude-from-settings')
  delete process.env.ARIA_MODEL
})

test('processInput sends the key, model and task list to Anthropic and parses the JSON action', async () => {
  const calls = []
  global.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: '```json\n{"action":"create","task":{"title":"Send deck"},"confirmation":"Added."}\n```' }] })
    }
  }
  const result = await processInput('send the deck to Maya', [{ id: 'a1', title: 'Old task', priority: 'low', status: 'todo' }], { apiKey: 'test-key', model: 'claude-test' })
  assert.deepStrictEqual(result, { action: 'create', task: { title: 'Send deck' }, confirmation: 'Added.' })
  const body = JSON.parse(calls[0].opts.body)
  assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.strictEqual(calls[0].opts.headers['x-api-key'], 'test-key')
  assert.strictEqual(body.model, 'claude-test')
  assert.match(body.system, /Old task/)
})

test('a 401 becomes a friendly error', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) })
  await assert.rejects(processInput('hi', [], { apiKey: 'bad' }), /API key is invalid/)
})

test('non-JSON replies are treated as answers', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: 'You have 2 tasks today.' }] }) })
  assert.deepStrictEqual(await processInput('what is on today?', [], { apiKey: 'k' }), { action: 'answer', message: 'You have 2 tasks today.' })
})
