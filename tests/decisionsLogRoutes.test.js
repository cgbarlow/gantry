import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { parseDecisionsLog } from '../web/lib/decisionsLog.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #288 (parent #238, docs/adr/0064): the decisions log on a server workspace. A stage Save writes the log and the content in one
// request; the log is `interview/<stageId>.yaml` next to `modules/`; entries are only ever appended, and a request that would change
// or remove one is refused without writing anything, the Modules included.

const SLUG = 'my-initiative'
const json = { 'Content-Type': 'application/json' }
const put = (base, path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const BACKGROUND = { status: 'draft', owner: '', fields: { problem: 'Claims take too long.', 'affected-domains': ['Claims'], opportunity: '' } }

const answer = (id, over = {}) => ({ id, kind: 'answer', at: '2026-11-02T10:00:00.000Z', session: 's-1', question: `Question ${id}`, answer: ['Yes'], fields: ['background.problem'], ...over })
const delta = (entries, over = {}) => ({
  status: { session: 's-1', who: 'a.architect', target: 'shape', state: 'in-progress', artefact: 'soap', models: [{ type: 'anthropic', model: 'claude-x', inputTokens: 5, cachedTokens: 1, outputTokens: 2 }], instructions: 'design@3', skills: { grilling: '1.0.0' } },
  fields: { 'background.problem': { drafted: '2026-11-02T10:00:00.000Z', inputs: [{ source: 'client-brief', title: 'Client brief', range: 'pages 1-2', fingerprint: 'abc123' }], entries: [entries[0]?.id].filter(Boolean) } },
  entries,
  ...over,
})

async function withInstance(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-288-'))
  try {
    createInstance('design', SLUG, { instancesDir })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) => fn(base, join(instancesDir, 'default', SLUG)))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a stage Save carries the decisions log and writes it with the Modules, in interview/<stage>.yaml', async () => {
  await withInstance(async (base, dir) => {
    const empty = await (await fetch(`${base}/api/instance/decisions?slug=${SLUG}`)).json()
    assert.deepEqual(empty.log.entries, [])

    const res = await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: BACKGROUND }, decisions: delta([answer('s-1-1')]) })
    assert.equal(res.status, 200)
    assert.match(readFileSync(join(dir, 'modules', 'background.md'), 'utf8'), /Claims take too long/)
    const file = join(dir, 'interview', 'shape.yaml')
    assert.ok(existsSync(file), 'next to modules/')
    const log = parseDecisionsLog(readFileSync(file, 'utf8'), 'shape')
    assert.deepEqual(log.entries.map((e) => e.id), ['s-1-1'])
    assert.equal(log.status[0].session, 's-1')
    assert.deepEqual(log.status[0].models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 5, cachedTokens: 1, outputTokens: 2 }])
    assert.equal(log.fields['background.problem'].inputs[0].fingerprint, 'abc123')

    const read = await (await fetch(`${base}/api/instance/decisions?slug=${SLUG}&stage=shape`)).json()
    assert.deepEqual(read.log, log)
  })
})

test('a Save without a log writes no log file, and the log can be saved alone', async () => {
  await withInstance(async (base, dir) => {
    assert.equal((await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: BACKGROUND } })).status, 200)
    assert.equal(existsSync(join(dir, 'interview')), false)
    const alone = await put(base, `/api/instance/decisions?slug=${SLUG}`, { decisions: delta([answer('s-1-1')]) })
    assert.equal(alone.status, 200)
    assert.equal((await alone.json()).log.entries.length, 1)
    assert.ok(existsSync(join(dir, 'interview', 'shape.yaml')))
  })
})

test('entries only ever grow: later Saves append, the same entry again adds nothing, and the earlier ones stay as they were', async () => {
  await withInstance(async (base, dir) => {
    await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: BACKGROUND }, decisions: delta([answer('s-1-1')]) })
    const first = readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8')
    await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: BACKGROUND }, decisions: delta([answer('s-1-1'), answer('s-1-2', { at: '2026-11-02T10:05:00.000Z', replaces: ['s-1-1'] })]) })
    const log = parseDecisionsLog(readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8'), 'shape')
    assert.deepEqual(log.entries.map((e) => e.id), ['s-1-1', 's-1-2'])
    assert.deepEqual(log.entries[0], parseDecisionsLog(first, 'shape').entries[0], 'the first entry is byte-for-byte what it was')
  })
})

test('a request that would change an entry is refused, and nothing is written, the Modules included', async () => {
  await withInstance(async (base, dir) => {
    await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: BACKGROUND }, decisions: delta([answer('s-1-1')]) })
    const logBefore = readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8')
    const moduleBefore = readFileSync(join(dir, 'modules', 'background.md'), 'utf8')

    const changed = { ...BACKGROUND, fields: { ...BACKGROUND.fields, problem: 'A different problem.' } }
    const refused = await put(base, `/api/instance/modules?slug=${SLUG}`, { modules: { background: changed }, decisions: delta([answer('s-1-1', { answer: ['No'] })]) })
    assert.equal(refused.status, 409)
    assert.equal((await refused.json()).code, 'append-only')
    assert.equal(readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8'), logBefore)
    assert.equal(readFileSync(join(dir, 'modules', 'background.md'), 'utf8'), moduleBefore)

    const alone = await put(base, `/api/instance/decisions?slug=${SLUG}`, { decisions: delta([answer('s-1-1', { answer: ['No'] })]) })
    assert.equal(alone.status, 409)
    assert.equal(readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8'), logBefore)
  })
})

test('a status line with a key, an address or a custom name never reaches the file', async () => {
  await withInstance(async (base, dir) => {
    const dirty = delta([answer('s-1-1')])
    dirty.status = { ...dirty.status, apiKey: 'sk-ant-SECRET0123456789', address: 'https://private.example.com', customName: 'My team AI', models: [{ type: 'anthropic', model: 'claude-x', key: 'sk-ant-SECRET0123456789', address: 'https://private.example.com', name: 'My team AI' }] }
    await put(base, `/api/instance/decisions?slug=${SLUG}`, { decisions: dirty })
    const file = readFileSync(join(dir, 'interview', 'shape.yaml'), 'utf8')
    for (const secret of ['SECRET', 'private.example', 'My team AI', 'apiKey', 'customName']) assert.ok(!file.includes(secret), `${secret} is not in the file`)
  })
})
