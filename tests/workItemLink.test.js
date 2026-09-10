import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance } from '../lib/instance.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import {
  linkInstanceToWorkItem,
  syncGatePassToWorkItem,
  tagLinkedWorkItems,
  tagAllLinkedWorkItems,
  pickPassedState,
  DEFAULT_WORK_ITEM_TYPE,
} from '../lib/workItemLink.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withScratchInstances, VALID_PAT } from './helpers/lifecycle.js'

// #95/#103: optional instance-level link to an Azure DevOps work item, per-stage child work-item auto-creation, and confirmed read-write state sync on gate pass. The Work Items side always talks to the in-process fake server (#99's extension of tests/helpers/fakeAzureDevOpsServer.js) — never a mocked client — the same convention every other Azure DevOps client test in this repo follows.

const WI_ORGANIZATION = 'wi-org'
const WI_PROJECT = 'wi-project'


// Only the Work Items endpoints matter for these tests — no `repository`, mirroring tests/azureDevOpsWorkItemsClient.test.js's own wrapper.
function withFakeWorkItemsServer(overrides, fn) {
  return withFakeAzureDevOpsServer(
    { organization: WI_ORGANIZATION, project: WI_PROJECT, validPat: VALID_PAT, ...overrides },
    fn
  )
}

async function createParentWorkItem(baseUrl) {
  const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
  const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
  return parent.id
}

// Fills in the Shape stage's three modules with the same content the `examples` fixture already carries, so `checkGate`'s "business-case" gate genuinely passes — reused by every gate-pass-sync test below rather than hand-writing each field.
function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    cpSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), join(instancesDir, slug, 'modules', `${moduleId}.md`))
  }
}

// ---------- linkInstanceToWorkItem ----------

test('linkInstanceToWorkItem creates one child work item per definition stage, under the given parent, and records the link on instance.yaml', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)

      const workItem = await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )

      assert.equal(workItem.organization, WI_ORGANIZATION)
      assert.equal(workItem.project, WI_PROJECT)
      assert.equal(workItem.parentId, parentId)
      assert.equal(workItem.workItemType, DEFAULT_WORK_ITEM_TYPE)
      assert.deepEqual(Object.keys(workItem.stages).sort(), ['detailed-design', 'handover', 'hld-define', 'shape'])
      assert.equal(typeof workItem.stages.shape, 'number')

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      const shapeChild = await client.getWorkItem(workItem.stages.shape)
      assert.equal(
        shapeChild.fields['System.Description'],
        'Tracks the "SOAP" stage (stage "shape", gate "business-case") of gantry instance "my-initiative".\n\n' +
          'Artefacts for this stage:\n' +
          '- Solution on a Page\n' +
          '- Full Solution on a Page'
      )

      // Recorded on instance.yaml — readInstance sees it directly.
      const instance = readInstance('my-initiative', { instancesDir })
      assert.deepEqual(instance.workItem, workItem)

      // Every other pre-existing field on instance.yaml is preserved.
      assert.equal(instance.definition, 'design')
      assert.equal(instance.stage, 'shape')

      for (const workItemId of Object.values(workItem.stages)) {
        const stageWorkItem = await client.getWorkItem(workItemId)
        assert.equal(stageWorkItem.fields['System.Tags'], 'gantry')
      }
    })
  })
})

test('tagLinkedWorkItems tags only recorded stage work items, preserves tags, and reports idempotent counts', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)
      const workItem = await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )
      const shapeId = workItem.stages.shape
      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      for (const workItemId of Object.values(workItem.stages)) {
        await client.updateWorkItem(workItemId, { 'System.Tags': 'ready-for-agent; bug' })
      }

      const first = await tagLinkedWorkItems('my-initiative', { instancesDir, pat: VALID_PAT, baseUrl })
      assert.equal(first.updated, 4)
      assert.equal(first.alreadyTagged, 0)
      assert.equal((await client.getWorkItem(shapeId)).fields['System.Tags'], 'ready-for-agent; bug; gantry')

      const second = await tagLinkedWorkItems('my-initiative', { instancesDir, pat: VALID_PAT, baseUrl })
      assert.equal(second.updated, 0)
      assert.equal(second.alreadyTagged, 4)
    })
  })
})

test('tagAllLinkedWorkItems scans every registered linked instance and skips unlinked instances', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      // WI #356: instances live inside a real server workspace folder (`default`, the reserved
      // scope) — `tagAllLinkedWorkItems`'s own registry scan only auto-discovers instances there.
      writeWorkspaceJson(instancesDir, 'default', { name: 'default', kind: 'local', createdAt: new Date().toISOString() })
      const localInstancesDir = join(instancesDir, 'default')
      const linkedSlugs = ['first-initiative', 'second-initiative']
      const links = []
      for (const slug of [...linkedSlugs, 'unlinked-initiative']) {
        createInstance('design', slug, { instancesDir: localInstancesDir })
        if (slug === 'unlinked-initiative') continue
        const parentId = await createParentWorkItem(baseUrl)
        links.push(
          await linkInstanceToWorkItem(
            slug,
            { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
            { instancesDir: localInstancesDir }
          )
        )
      }

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      for (const link of links) {
        for (const workItemId of Object.values(link.stages)) {
          await client.updateWorkItem(workItemId, { 'System.Tags': 'ready-for-agent' })
        }
      }

      const result = await tagAllLinkedWorkItems({ instancesDir, pat: VALID_PAT })
      assert.equal(result.updated, 8)
      assert.equal(result.alreadyTagged, 0)
      assert.deepEqual(result.failed, [])
      assert.deepEqual(result.instances.map((instance) => instance.slug), linkedSlugs)
    })
  })
})

test('tagAllLinkedWorkItems accepts per-instance credentials and continues after an instance failure', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      writeWorkspaceJson(instancesDir, 'default', { name: 'default', kind: 'local', createdAt: new Date().toISOString() })
      const localInstancesDir = join(instancesDir, 'default')
      const links = []
      for (const slug of ['first-initiative', 'second-initiative']) {
        createInstance('design', slug, { instancesDir: localInstancesDir })
        const parentId = await createParentWorkItem(baseUrl)
        links.push(
          await linkInstanceToWorkItem(
            slug,
            { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
            { instancesDir: localInstancesDir }
          )
        )
      }

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      for (const link of links) {
        for (const workItemId of Object.values(link.stages)) {
          await client.updateWorkItem(workItemId, { 'System.Tags': 'ready-for-agent' })
        }
      }

      const result = await tagAllLinkedWorkItems({
        instancesDir,
        patsBySlug: { 'first-initiative': 'rejected-pat', 'second-initiative': VALID_PAT },
      })
      assert.equal(result.updated, 4)
      assert.equal(result.alreadyTagged, 0)
      assert.deepEqual(result.instances.map((instance) => instance.slug), ['second-initiative'])
      assert.deepEqual(result.failed.map((failure) => failure.slug), ['first-initiative'])
    })
  })
})

test('linkInstanceToWorkItem\'s child work items are genuinely linked to the parent via a Hierarchy-Reverse relation', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)
      const workItem = await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      // Any further update against the shape child confirms it's a real, independently addressable work item — not a fabricated id.
      const updated = await client.updateWorkItem(workItem.stages.shape, { 'System.State': 'Active' })
      assert.equal(updated.fields['System.State'], 'Active')
    })
  })
})

test('linkInstanceToWorkItem accepts a caller-configured workItemType instead of the default', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)
      const workItem = await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, workItemType: 'Bug', pat: VALID_PAT, baseUrl },
        { instancesDir }
      )
      assert.equal(workItem.workItemType, 'Bug')

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      const states = await client.getWorkItemTypeStates('Bug')
      assert.ok(states.length > 0)
    })
  })
})

test('linkInstanceToWorkItem refuses to link an instance that is already linked', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)
      await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )

      const secondParentId = await createParentWorkItem(baseUrl)
      await assert.rejects(
        () =>
          linkInstanceToWorkItem(
            'my-initiative',
            { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId: secondParentId, pat: VALID_PAT, baseUrl },
            { instancesDir }
          ),
        new RegExp(`already linked to Azure DevOps work item ${parentId}`)
      )
    })
  })
})

test('linkInstanceToWorkItem works against an Azure-DevOps-backed instance whose data lives in a different organization/project than the work item', async () => {
  await withFakeWorkItemsServer({}, async (wiBaseUrl) => {
    await withFakeAzureDevOpsServer(
      { organization: 'git-org', project: 'git-project', repository: 'git-repo', validPat: VALID_PAT, files: {} },
      async (gitBaseUrl) => {
        const azureDevOps = {
          organization: 'git-org',
          project: 'git-project',
          repository: 'git-repo',
          pat: VALID_PAT,
          baseUrl: gitBaseUrl,
        }
        await createInstance('design', 'my-initiative', { azureDevOps })

        const parentId = await createParentWorkItem(wiBaseUrl)
        const workItem = await linkInstanceToWorkItem(
          'my-initiative',
          { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl: wiBaseUrl },
          { azureDevOps }
        )

        assert.equal(workItem.organization, WI_ORGANIZATION)
        assert.equal(workItem.project, WI_PROJECT)

        const instance = await readInstance('my-initiative', { azureDevOps })
        assert.deepEqual(instance.workItem, workItem)
        // The instance's own data-storage location is untouched/unrelated.
        assert.deepEqual(instance.azureDevOps, { organization: 'git-org', project: 'git-project', repository: 'git-repo' })
      }
    )
  })
})

test('an instance with no workItem field is simply unlinked — readInstance reports it as undefined, not an error', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.workItem, undefined)
  })
})

// ---------- pickPassedState ----------

test('pickPassedState prefers a "Completed"-category state', () => {
  const state = pickPassedState([
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' },
  ])
  assert.equal(state, 'Closed')
})

test('pickPassedState falls back to a "Resolved"-category state when no "Completed" one exists', () => {
  const state = pickPassedState([
    { name: 'To Do', category: 'Proposed' },
    { name: 'Doing', category: 'InProgress' },
    { name: 'Fixed', category: 'Resolved' },
  ])
  assert.equal(state, 'Fixed')
})

test('pickPassedState falls back to the last reported state when neither category exists', () => {
  const state = pickPassedState([
    { name: 'Backlog', category: 'Proposed' },
    { name: 'In Progress', category: 'InProgress' },
  ])
  assert.equal(state, 'In Progress')
})

test('pickPassedState throws for an empty states list', () => {
  assert.throws(() => pickPassedState([]), /no states/)
})

// ---------- syncGatePassToWorkItem ----------

test('syncGatePassToWorkItem refuses to push a state when the gate has not passed', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const parentId = await createParentWorkItem(baseUrl)
      await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )

      await assert.rejects(
        () => syncGatePassToWorkItem('my-initiative', {}, { instancesDir, pat: VALID_PAT }),
        /has not passed/
      )
    })
  })
})

test('syncGatePassToWorkItem refuses to push a state for an unlinked instance', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    await assert.rejects(
      () => syncGatePassToWorkItem('my-initiative', {}, { instancesDir, pat: VALID_PAT }),
      /not linked to an Azure DevOps work item/
    )
  })
})

test('syncGatePassToWorkItem pushes a state drawn from the work item type\'s own valid states once the gate passes, and declining (never calling it) leaves that state alone', async () => {
  await withFakeWorkItemsServer({}, async (baseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      fillShapeStage(instancesDir, 'my-initiative')

      const parentId = await createParentWorkItem(baseUrl)
      const workItem = await linkInstanceToWorkItem(
        'my-initiative',
        { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl },
        { instancesDir }
      )

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
      const before = await client.getWorkItemTypeStates(DEFAULT_WORK_ITEM_TYPE)
      // Never fetched a work item directly here — this only proves the shape child's state starts out at its just-created default, since "declining" (this test never calls syncGatePassToWorkItem at all for a first assertion) must never have touched it.
      assert.notEqual(pickPassedState(before), 'New')

      const result = await syncGatePassToWorkItem('my-initiative', {}, { instancesDir, pat: VALID_PAT })
      assert.equal(result.workItemId, workItem.stages.shape)
      assert.equal(result.gate, 'business-case')
      assert.equal(result.stage.id, 'shape')
      assert.equal(result.state, pickPassedState(before))
      assert.equal(result.workItem.fields['System.State'], result.state)

      // Confirmed via the live server, not just the returned payload.
      const states = await client.getWorkItemTypeStates(DEFAULT_WORK_ITEM_TYPE)
      assert.equal(pickPassedState(states), result.state)
    })
  })
})

test('syncGatePassToWorkItem works against an Azure-DevOps-backed instance\'s data, checking the gate against that same backend', async () => {
  await withFakeWorkItemsServer({}, async (wiBaseUrl) => {
    const seedFiles = {
      '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
    }
    await withFakeAzureDevOpsServer(
      { organization: 'git-org', project: 'git-project', repository: 'git-repo', validPat: VALID_PAT, files: seedFiles },
      async (gitBaseUrl) => {
        const azureDevOps = {
          organization: 'git-org',
          project: 'git-project',
          repository: 'git-repo',
          pat: VALID_PAT,
          baseUrl: gitBaseUrl,
        }

        // Seed the three Shape-stage modules straight into the fake git repo, reusing the same examples-fixture content fillShapeStage copies for the local path.
        const gitClient = createAzureDevOpsClient(azureDevOps)
        for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
          const text = readFileSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), 'utf8')
          await gitClient.writeFile(`gantry-workspace/my-initiative/modules/${moduleId}.md`, text)
        }

        const parentId = await createParentWorkItem(wiBaseUrl)
        const workItem = await linkInstanceToWorkItem(
          'my-initiative',
          { organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, pat: VALID_PAT, baseUrl: wiBaseUrl },
          { azureDevOps }
        )

        const result = await syncGatePassToWorkItem('my-initiative', {}, { azureDevOps, pat: VALID_PAT })
        assert.equal(result.workItemId, workItem.stages.shape)
        assert.equal(result.gate, 'business-case')
      }
    )
  })
})
