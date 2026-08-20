import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { readInstance } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'

test('the examples fixture instance has every stage\'s gate requirements filled in', () => {
  const definition = loadDefinition('design')
  const instance = readInstance('examples')
  assert.equal(instance.definition, 'design')

  for (const stage of definition.stages) {
    const result = checkGate('examples', { gate: stage.gate })
    assert.equal(result.pass, true, `expected stage "${stage.id}" (gate "${stage.gate}") to pass`)
  }
})
