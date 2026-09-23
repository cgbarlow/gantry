import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, DEFAULT_PROVIDER , workItemParentRef, describeWorkItemLink } from '../web/lib/provider.js'

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

// ---------------------------------------------------------------------------
// #136: the work-item link shape differs per Provider and the display layer only knew one of them.
// `lib/workItemLink.js` writes Azure DevOps links as `{organization, project, workItemType,
// parentId}` and GitHub links (docs/adr/0040) as `{provider:'github', owner, repository,
// parentNumber}` — the writer has always handled both. Every reader in web/ took `parentId`, so a
// GitHub-linked instance showed a bare "#" in the module editor, "#undefined" in Settings under an
// "Azure DevOps work item" heading, and lost its Track Work Item link entirely. Same
// writer-knows/reader-doesn't drift as #135, one layer over.
// ---------------------------------------------------------------------------

test('workItemParentRef: a GitHub link resolves its parentNumber', () => {
  // The exact record shape read from a real workspace repo's instance.yaml.
  const workItem = { provider: 'github', owner: 'cgbarlow', repository: 'gantry-workspace-testing', parentNumber: 1, stages: { requisition: 2 } }
  assert.equal(workItemParentRef(workItem), 1)
})

test('workItemParentRef: an Azure DevOps link resolves its parentId', () => {
  const workItem = { organization: 'acme', project: 'proj', workItemType: 'Task', parentId: 42 }
  assert.equal(workItemParentRef(workItem), 42)
})

test('workItemParentRef: an unlinked instance resolves to null, never undefined', () => {
  // `undefined` is what produced the bare "#" — the caller cannot distinguish it from a real ref
  // without an explicit null, and `#undefined` is what Settings rendered.
  assert.equal(workItemParentRef(null), null)
  assert.equal(workItemParentRef(undefined), null)
  assert.equal(workItemParentRef({}), null)
})

test('workItemParentRef: issue number 0 is not mistaken for absent', () => {
  // `??` rather than `||` — a falsy-but-present ref must survive. No Provider numbers from zero
  // today, but a `||` here would be a silent trap for whichever one eventually does.
  assert.equal(workItemParentRef({ provider: 'github', parentNumber: 0 }), 0)
  assert.equal(workItemParentRef({ parentId: 0 }), 0)
})

test('describeWorkItemLink: GitHub is labelled as an issue, with no work-item-type row', () => {
  // docs/adr/0040 drops work-item type on GitHub rather than emulating it from labels, so the row
  // must be absent — not rendered blank or invented.
  const described = describeWorkItemLink({ provider: 'github', owner: 'cgbarlow', repository: 'gantry-workspace-testing' })
  assert.equal(described.heading, 'GitHub issue')
  assert.equal(described.parentLabel, 'Parent issue')
  assert.deepEqual(described.rows, [
    { k: 'Owner', v: 'cgbarlow' },
    { k: 'Repository', v: 'gantry-workspace-testing' },
  ])
  assert.ok(!described.rows.some((row) => row.k === 'Work item type'))
})

test('describeWorkItemLink: Azure DevOps keeps its existing heading, rows and parent label', () => {
  const described = describeWorkItemLink({ organization: 'acme', project: 'proj', workItemType: 'Task', parentId: 42 })
  assert.equal(described.heading, 'Azure DevOps work item')
  assert.equal(described.parentLabel, 'Parent work item')
  assert.deepEqual(described.rows, [
    { k: 'Organization', v: 'acme' },
    { k: 'Project', v: 'proj' },
    { k: 'Work item type', v: 'Task' },
  ])
})

test('describeWorkItemLink: an unlinked instance describes nothing', () => {
  assert.equal(describeWorkItemLink(null), null)
})

test('describeWorkItemLink: no Provider shape yields an undefined heading or parent label', () => {
  // The regression guard: a shape that falls through to a default must still be renderable, because
  // these strings are put straight on screen.
  for (const workItem of [
    { provider: 'github', owner: 'o', repository: 'r', parentNumber: 1 },
    { provider: 'gitlab', namespace: 'n', repository: 'r', parentNumber: 1 },
    { organization: 'o', project: 'p', workItemType: 'Task', parentId: 1 },
    { provider: 'something-new', parentId: 1 },
  ]) {
    const described = describeWorkItemLink(workItem)
    assert.equal(typeof described.heading, 'string')
    assert.ok(described.heading.length > 0)
    assert.equal(typeof described.parentLabel, 'string')
    assert.ok(described.parentLabel.length > 0)
    assert.ok(Array.isArray(described.rows))
  }
})
