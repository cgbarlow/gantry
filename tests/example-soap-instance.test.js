import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { readInstance, readModule } from '../lib/instance.js'

test('the example-soap fixture instance has every required Shape field filled in', () => {
  const definition = loadDefinition('design')
  const instance = readInstance('example-soap')
  assert.equal(instance.definition, 'design')
  assert.equal(instance.stage, 'shape')

  const shape = definition.stages.find((stage) => stage.id === 'shape')
  for (const moduleId of shape.modules) {
    const moduleSpec = definition.modules.get(moduleId)
    const data = readModule(definition, 'example-soap', moduleId)
    assert.equal(data.status, 'agreed')

    for (const field of moduleSpec.fields) {
      if (!field.required) continue
      const value = data.fields[field.id]
      assert.ok(value !== undefined, `${moduleId}.${field.id} should be present`)
      const isEmpty = Array.isArray(value) ? value.length === 0 : value.trim() === ''
      assert.ok(!isEmpty, `${moduleId}.${field.id} should not be empty`)
    }
  }
})
