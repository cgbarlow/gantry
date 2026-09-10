import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkGate } from '../lib/check.js'
import { renderArtefact } from '../lib/render.js'
import { splitArtefactRequirement } from '../lib/definition.js'
import { readInstance, readModule, loadDefinitionForInstance } from '../lib/instance.js'
import { replaceMermaidBlocks } from '../web/lib/mermaid.js'

// WI #354 — the bundled `gantry` instance is Gantry's own hosting proposal, authored as a
// complete Full SOAP (every `soap-full` field) with Mermaid diagrams. It is dogfooding, and
// this pins what "complete" means so a definition change that silently breaks it is caught:
// the Business Case Approved gate must keep passing, every soap-full field must stay
// non-empty, and the diagrams must be real fenced ```mermaid blocks.

const EXAMPLES_WORKSPACE_DIR = 'workspaces/examples'
const INSTANCE_DIR = join(EXAMPLES_WORKSPACE_DIR, 'gantry')

test('the gantry instance passes Business Case Approved on its shape stage', () => {
  const result = checkGate('gantry', { instancesDir: EXAMPLES_WORKSPACE_DIR })
  assert.equal(result.gate, 'business-case')
  assert.equal(result.pass, true, JSON.stringify(result, null, 2))
})

test('every field the Full SOAP requires, and every optional one it renders, has content in the gantry instance', () => {
  const instance = readInstance('gantry', { instancesDir: EXAMPLES_WORKSPACE_DIR })
  const definition = loadDefinitionForInstance(instance)
  const soapFull = definition.artefacts.find((a) => a.id === 'soap-full')
  assert.ok(soapFull, 'the v2 design definition has a soap-full artefact')
  const modules = new Map()
  const missing = []
  for (const ref of soapFull.requires) {
    const { moduleId, fieldId } = splitArtefactRequirement(ref)
    // Epic/Project is deliberately blank (no epic exists yet for hosting Gantry itself).
    if (moduleId === 'soap-full-details' && fieldId === 'epic-project') continue
    if (!modules.has(moduleId)) modules.set(moduleId, readModule(definition, 'gantry', moduleId, { instancesDir: EXAMPLES_WORKSPACE_DIR }).fields)
    const value = modules.get(moduleId)[fieldId]
    const empty = Array.isArray(value) ? value.length === 0 : !(value ?? '').trim()
    if (empty) missing.push(ref)
  }
  assert.deepEqual(missing, [], 'soap-full fields with no content')
})

test('the gantry instance carries its six diagrams as fenced mermaid blocks that parse as flowcharts or a gantt', () => {
  const modulesDir = join(INSTANCE_DIR, 'modules')
  let total = 0
  const kinds = []
  for (const file of readdirSync(modulesDir)) {
    const { blocks } = replaceMermaidBlocks(readFileSync(join(modulesDir, file), 'utf8'), () => '')
    total += blocks.length
    for (const b of blocks) kinds.push(b.code.trim().split(/\s/)[0])
  }
  assert.equal(total, 6, `expected six diagrams, found ${total}`)
  assert.deepEqual([...new Set(kinds)].sort(), ['flowchart', 'gantt'])
})

test('both shape artefacts of the gantry instance compile without native pandoc, keeping the Mermaid source in the markdown', () => {
  for (const artefactId of ['soap', 'soap-full']) {
    const result = renderArtefact('gantry', artefactId, { dryRun: true, instancesDir: EXAMPLES_WORKSPACE_DIR })
    assert.ok(result.markdown.includes('```mermaid'), `${artefactId} keeps the fenced Mermaid source`)
    assert.ok(!/<[a-z-]+-subscription>/.test(result.markdown) || result.markdown.includes('<contoso-uat-subscription>'), 'placeholders render verbatim')
  }
})
