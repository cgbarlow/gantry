import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../src/toolRegistry.js'

test('every registered tool has a name and a meaningfully-long description', async () => {
  const tools = await loadTools()
  assert.ok(tools.length > 0, 'at least one tool should be registered')

  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string', `${tool.name} must have a string name`)
    assert.ok(tool.name.length > 0)
    assert.equal(typeof tool.description, 'string', `${tool.name} must have a string description`)
    assert.ok(tool.description.length >= 40, `${tool.name}'s description is too short to be useful to a model`)
    assert.equal(typeof tool.handler, 'function', `${tool.name} must have a handler function`)
  }
})

test('no two tools share a name', async () => {
  const tools = await loadTools()
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
})
