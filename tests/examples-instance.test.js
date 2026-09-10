import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { readInstance } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'

const EXAMPLES_WORKSPACE_DIR = 'workspaces/examples'

test('the examples fixture instance has every stage\'s gate requirements filled in', () => {
  const definition = loadDefinition('design')
  const instance = readInstance('kiwi-cover-mutual', { instancesDir: EXAMPLES_WORKSPACE_DIR })
  assert.equal(instance.definition, 'design')

  for (const stage of definition.stages) {
    const result = checkGate('kiwi-cover-mutual', { instancesDir: EXAMPLES_WORKSPACE_DIR, gate: stage.gate })
    assert.equal(result.pass, true, `expected stage "${stage.id}" (gate "${stage.gate}") to pass`)
  }
})
