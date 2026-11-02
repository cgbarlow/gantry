import { createServer as createHttpServer } from 'node:http'

// A stand-in for Anthropic for the AI interview's browser tests (#295): it answers the Messages API as a stream, drafting the one Field
// each Stage of the small three-Stage Definition (tests/helpers/trioDefinition.js) needs, and records what it was sent. The Interview
// page talks to it through the real relay, with an AI Provider seeded into the browser's storage.

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

export function anthropicReply({ text, tools = [] }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: 'draft_field', input: {} } }])
    const json = JSON.stringify(tool.input)
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 11) } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(11) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}

/** Which Stage of the trio the AI is being asked about: the brief carries that Stage's purpose. */
export const trioStageOf = (body) => ['s1', 's2', 's3'].find((id) => JSON.stringify(body.system ?? '').includes(`PURPOSE-${id}`))
const MODULE = { s1: 'm1', s2: 'm2', s3: 'm3' }

/** The first turn of a Stage drafts its one Field; the turn after the draft result is a short reply. */
export const trioScript = (body) => {
  const stage = trioStageOf(body)
  if (body.messages.length === 1) return { text: `Reading for ${stage}.`, tools: [{ id: `d-${stage}`, input: { field: `${MODULE[stage]}.body`, value: `Notes for ${stage}: the agreed position, written out.` } }] }
  return { text: `${stage} is drafted.` }
}

/**
 * #296: the script for the trio with a shared Module (`writeTrio(dir, { shared: true })`). Scope drafts its Field and the shared Module's
 * `body`. Shape, drafted ahead of Scope's approval, can draft only its own Module (the shared one is held), and it extends the shared
 * Module's `more` only when it is told the Module is no longer held.
 */
export const sharedScript = (body) => {
  const stage = trioStageOf(body)
  const draft = (id, field, value) => ({ id, input: { field, value } })
  if (body.messages.length === 1) {
    if (stage === 's1') return { text: 'Reading for s1.', tools: [draft('d-m1', 'm1.body', 'Notes for s1: the agreed position, written out.'), draft('d-mx', 'mx.body', 'Shared position set at s1.')] }
    return { text: `Reading for ${stage}.`, tools: [draft(`d-${stage}`, `${MODULE[stage]}.body`, `Notes for ${stage}: the agreed position, written out.`)] }
  }
  if (JSON.stringify(body.messages[body.messages.length - 1]).includes('no longer held')) return { text: 'Extending the shared notes.', tools: [draft('d-more', 'mx.more', 'Shape extends the shared notes.')] }
  return { text: `${stage} is drafted.` }
}

export function withFakeAnthropic(script, fn) {
  const posts = []
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-small', max_input_tokens: 200000 }] }))
        return
      }
      posts.push({ key: req.headers['x-api-key'] ?? null, raw, body: JSON.parse(raw) })
      const reply = anthropicReply(script(JSON.parse(raw), posts.length - 1))
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(reply)
      }, 200)
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, posts)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

/** Puts one tested, Default AI Provider in the page's storage, pointing at the stand-in. */
export function seedProviders(page, aiBase) {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed }]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}
