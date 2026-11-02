import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedCopyFilename, findArtefactsNeedingReRender, ReRenderRequiredError, assertEarlierArtefactsReRendered } from '../lib/reRenderEarlier.js'
import { reRenderItemLabel, reRenderRefusalLine } from '../web/lib/changedSinceApproval.js'
import { loadDefinition } from '../lib/definition.js'

// #276, ADR-0069 — the pure parts of re-rendering before re-approval. The routes, the Providers and the
// editor are covered by tests/serverReRenderEarlier.test.js and tests/reRenderEarlier.playwright.test.js.

test('the approved copy is named with its approval date before the extension', () => {
  assert.equal(
    approvedCopyFilename('Atlas - SOAP.docx', { approvedOn: '2026-10-12', pullRequestId: 7 }),
    'Atlas - SOAP — approved 2026-10-12.docx'
  )
})

test('an approval whose date the Provider did not give is named by its Pull Request instead', () => {
  assert.equal(
    approvedCopyFilename('Atlas - SOAP.docx', { approvedOn: null, pullRequestId: 7 }),
    'Atlas - SOAP — approved in Pull Request 7.docx'
  )
})

test('only the dot before the extension is split on', () => {
  assert.equal(
    approvedCopyFilename('v1.2 - Offer Pack.docx', { approvedOn: '2026-01-02', pullRequestId: 1 }),
    'v1.2 - Offer Pack — approved 2026-01-02.docx'
  )
})

test('nothing needs re-rendering for a provider with no flag, or when nothing is flagged', async () => {
  const definition = loadDefinition('design', { version: 2 })
  assert.deepEqual(await findArtefactsNeedingReRender({ providerKey: 'atlassian', definition, flagged: [{ stageId: 'shape', fields: ['background.problem'] }] }), [])
  await assert.doesNotReject(
    assertEarlierArtefactsReRendered({
      providerKey: 'github',
      base: {},
      slug: 'x',
      definition,
      instance: { stage: 'hld-define' },
      branch: 'b',
      flagged: [],
    })
  )
})

test('the refusal carries the Artefacts still to render', () => {
  const error = new ReRenderRequiredError('refused', [{ artefactId: 'soap' }])
  assert.equal(error.name, 'ReRenderRequiredError')
  assert.deepEqual(error.artefacts, [{ artefactId: 'soap' }])
})

test('the editor words the documents to re-render the same way everywhere', () => {
  const item = { stageTitle: 'SOAP', artefactTitle: 'Solution on a Page', count: 2 }
  assert.equal(reRenderItemLabel(item), 'Solution on a Page (SOAP, 2 Fields changed)')
  assert.match(reRenderRefusalLine([item]), /^Request sign-off needs this document re-rendered onto this stage first: Solution on a Page \(SOAP, 2 Fields changed\)\.$/)
  assert.match(reRenderRefusalLine([item, { ...item, artefactTitle: 'Full SOAP', count: 1 }]), /these documents .*Full SOAP \(SOAP, 1 Field changed\)/)
})
