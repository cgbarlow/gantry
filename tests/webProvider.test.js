import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, DEFAULT_PROVIDER } from '../web/lib/provider.js'

// The "+ New Workspace" wizard's own Provider picker (#8, docs/adr/0037; gitlab #25, ADR-0041;
// atlassian #48, ADR-0042). Every provider ADR-0037's model names is now a real, selectable choice —
// no provider is left "known but visibly disabled" any more.

test('every modelled provider is present and none is disabled', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ['azure-devops', 'github', 'gitlab', 'atlassian']
  )
  for (const provider of PROVIDERS) {
    assert.equal(provider.disabled, false, `${provider.id} should be selectable`)
  }
})

test('atlassian is labelled "Atlassian" and carries no disabledReason', () => {
  const atlassian = PROVIDERS.find((p) => p.id === 'atlassian')
  assert.equal(atlassian.label, 'Atlassian')
  assert.equal(atlassian.disabledReason, undefined)
})

test('DEFAULT_PROVIDER is unaffected — still azure-devops', () => {
  assert.equal(DEFAULT_PROVIDER, 'azure-devops')
})
