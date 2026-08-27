import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  artefactFieldIds,
  artefactsHaveDifferentRequirements,
  defaultArtefactId,
  readArtefactSelection,
  sortArtefacts,
} from '../web/lib/artefactSelection.js'

const modules = [
  { id: 'context', fields: [{ id: 'driver' }, { id: 'affected-domains' }] },
  { id: 'details', fields: [{ id: 'summary' }, { id: 'notes' }] },
]

test('artefact selection sorts by id and defaults to the first valid artefact', () => {
  const artefacts = [{ id: 'ssad', title: 'SSAD' }, { id: 'sad', title: 'SAD' }]
  assert.deepEqual(sortArtefacts(artefacts).map((artefact) => artefact.id), ['sad', 'ssad'])
  assert.equal(defaultArtefactId(artefacts), 'sad')
  assert.equal(readArtefactSelection('example', 'shape', artefacts), 'sad')
})

test('whole-module and field requirements expand to the visible field ids', () => {
  assert.deepEqual(
    [...artefactFieldIds(modules, { requires: ['context', 'details.summary'] })].sort(),
    ['context.affected-domains', 'context.driver', 'details.summary']
  )
})

test('requirement comparison only asks for a selector when the visible field sets differ', () => {
  const same = [{ requires: ['context'] }, { requires: ['context'] }]
  const different = [{ requires: ['context'] }, { requires: ['context.driver'] }]
  assert.equal(artefactsHaveDifferentRequirements(modules, same), false)
  assert.equal(artefactsHaveDifferentRequirements(modules, different), true)
  assert.equal(artefactsHaveDifferentRequirements(modules, [different[0]]), false)
})
