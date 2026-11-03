import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubWorkItemsClient } from '../lib/githubWorkItemsClient.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import {
  withRunningServerForProvider,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
} from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #275, ADR-0069 — the later stage's Pull Request re-approves the earlier stage it changed. Real HTTP against a real
// gantry server and a real in-process fake of each provider, for GitHub and Azure DevOps.
//
// The scenario is #273's: SOAP (`shape`) is approved and merged by its own reviewer, the Instance moves on to HLD
// (`hld-define`), and HLD fills its gate, which also changes Fields SOAP prints (`background.problem` reworded here;
// `dependencies` and `open-questions` were empty when SOAP was approved). HLD's own reviewer is a different person from
// SOAP's, so HLD's Pull Request needs two votes.

const SLUG = 'reapproval'
const definition = loadDefinition('design', { version: 2 })
const SHAPE = definition.stages.find((s) => s.id === 'shape')
const HLD = definition.stages.find((s) => s.id === 'hld-define')
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']
const MODULE_PATH = (moduleId) => `gantry-workspace/${SLUG}/modules/${moduleId}.md`
const INSTANCE_PATH = `gantry-workspace/${SLUG}/instance.yaml`
const DOC = (title) => `gantry-workspace/${SLUG}/out/Reapproval - ${title}.docx`

function instanceYaml(extra = '') {
  return `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n${extra}`
}

function withFieldText(text, title, body) {
  const heading = `## ${title}`
  const start = text.indexOf(`${heading}\n`)
  assert.notEqual(start, -1, `module text has a "${title}" section`)
  const bodyStart = start + heading.length + 1
  const next = text.indexOf('\n## ', bodyStart)
  return `${text.slice(0, bodyStart)}\n${body}\n${next === -1 ? '' : text.slice(next)}`
}

// Per provider: how to stand the fixture up, and how the people involved vote. `soapOwner` approved SOAP; `hldOwner` is
// the Instance's required reviewer, so the one HLD's own Pull Request names; `bystander` is nobody in particular.
const PROVIDERS = {
  github: {
    name: 'GitHub',
    kind: 'github',
    people: { soapOwner: 'soap-owner', hldOwner: 'hld-owner', bystander: 'bystander' },
    names: { soapOwner: 'soap-owner', hldOwner: 'hld-owner' },
    requiredReviewer: 'hld-owner',
    fakeServerOptions: () => ({
      files: { [`/${INSTANCE_PATH}`]: instanceYaml('requiredReviewer: hld-owner\n') },
      collaborators: [
        { login: 'hld-owner', id: 11 },
        { login: 'soap-owner', id: 12 },
      ],
    }),
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    credentials: (ctx) => ({ ...PROVIDERS.github.location(ctx), pat: GITHUB_VALID_PAT }),
    client: (ctx) => createGitHubClient(PROVIDERS.github.credentials(ctx)),
    resolveBranch: (ctx, stageId) => resolveGitHubStageBranch(PROVIDERS.github.credentials(ctx), definition, SLUG, stageId),
    auth: () => ({ Authorization: basicAuthHeader(GITHUB_VALID_PAT) }),
    vote: async (ctx, pullRequestId, person, kind) => {
      await fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { approve: 'APPROVE', changes: 'REQUEST_CHANGES' }[kind], login: person }),
      })
    },
    pullRequest: async (ctx, pullRequestId) => {
      const pr = await (await fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}`, { headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` } })).json()
      return { description: pr.body, requested: (pr.requested_reviewers ?? []).map((r) => r.login) }
    },
    linkWorkItems: async (ctx) => {
      const client = createGitHubWorkItemsClient(PROVIDERS.github.credentials(ctx))
      const [parent, shape, hld] = [await client.createIssue({ title: 'parent' }), await client.createIssue({ title: 'shape' }), await client.createIssue({ title: 'hld' })]
      return {
        yaml: `workItem:\n  provider: github\n  owner: ${GITHUB_OWNER}\n  repository: ${GITHUB_REPOSITORY}\n  baseUrl: ${ctx.providerBaseUrl}\n  parentNumber: ${parent.number}\n  stages:\n    shape: ${shape.number}\n    hld-define: ${hld.number}\n`,
        shapeItem: shape.number,
        read: async (id) => (await client.getIssue(id)).comments?.map((c) => c.body) ?? [],
      }
    },
  },
  'azure-devops': {
    name: 'Azure DevOps',
    kind: 'azureDevOps',
    // The people are Azure DevOps reviewer ids. `fake-identity-id-001` is the one identity the fake directory resolves.
    people: { soapOwner: 'soap-owner', hldOwner: 'fake-identity-id-001', bystander: 'bystander' },
    names: { soapOwner: 'SOAP Owner', hldOwner: 'Test User' },
    requiredReviewer: 'Test User',
    fakeServerOptions: () => ({ files: { [`/${INSTANCE_PATH}`]: instanceYaml('requiredReviewer: Test User\n') } }),
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    credentials: (ctx) => ({ ...PROVIDERS['azure-devops'].location(ctx), pat: VALID_PAT }),
    client: (ctx) => createAzureDevOpsClient(PROVIDERS['azure-devops'].credentials(ctx)),
    resolveBranch: (ctx, stageId) => resolveStageBranch(PROVIDERS['azure-devops'].credentials(ctx), definition, SLUG, stageId),
    auth: () => ({ Authorization: basicAuthHeader(VALID_PAT) }),
    // The fake merges a branch against a fixed base, so (as a real repository's clean-up of a merged branch would) the
    // merged SOAP branch goes, and HLD's own branch is cut from `main` rather than stacked on it.
    afterSoapMerged: async (ctx, client) => {
      const shapeBranch = `gantry-workspace/${SLUG}/shape`
      await fetch(`${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/${'gi' + 't'}/repositories/${REPOSITORY}/refs?api-version=7.1`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ name: `refs/heads/${shapeBranch}`, oldObjectId: await client.getBranchObjectId(shapeBranch), newObjectId: '0'.repeat(40) }]),
      })
      assert.equal(await client.branchExists(shapeBranch), false)
    },
    vote: async (ctx, pullRequestId, person, kind) => {
      await fetch(
        `${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/${person}`,
        {
          method: 'PUT',
          headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: { 'soap-owner': 'SOAP Owner', 'fake-identity-id-001': 'Test User', bystander: 'Bystander' }[person], vote: { approve: 10, changes: -5 }[kind] }),
        }
      )
    },
    pullRequest: async (ctx, pullRequestId) => {
      const pr = await (
        await fetch(`${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      return { description: pr.description, requested: pr.reviewers.filter((r) => r.isRequired).map((r) => r.id) }
    },
    linkWorkItems: async (ctx) => {
      const client = createAzureDevOpsWorkItemsClient(PROVIDERS['azure-devops'].credentials(ctx))
      const [parent, shape, hld] = [
        await client.createWorkItem('Task', { 'System.Title': 'parent' }),
        await client.createWorkItem('Task', { 'System.Title': 'shape' }),
        await client.createWorkItem('Task', { 'System.Title': 'hld' }),
      ]
      return {
        yaml: `workItem:\n  organization: ${ORGANIZATION}\n  project: ${PROJECT}\n  workItemType: Task\n  baseUrl: ${ctx.providerBaseUrl}\n  parentId: ${parent.id}\n  stages:\n    shape: ${shape.id}\n    hld-define: ${hld.id}\n`,
        shapeItem: shape.id,
        read: async (id) => [(await client.getWorkItem(id)).fields['System.History']].filter(Boolean),
      }
    },
  },
}

// Runs `fn(env)` against a fresh server+fake pair with SOAP approved (by the SOAP owner) and merged, and the Instance at HLD.
async function withApprovedSoap(providerId, fn, { linkWorkItems = false } = {}) {
  const provider = PROVIDERS[providerId]
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(
      providerId,
      { options: { instancesDir }, fakeServerOptions: provider.fakeServerOptions() },
      async (ctx) => {
        registerInstance(SLUG, { kind: provider.kind, ...provider.location(ctx) }, { instancesDir })
        const client = provider.client(ctx)
        const headers = provider.auth()
        const get = async (path) => (await fetch(`${ctx.gantryBase}${path}`, { headers })).json()
        const post = async (path) => (await fetch(`${ctx.gantryBase}${path}`, { method: 'POST', headers })).json()

        let linked = null
        if (linkWorkItems) {
          linked = await provider.linkWorkItems(ctx)
          const seeded = await client.getFileContent(INSTANCE_PATH, { branch: 'main' })
          await client.writeFile(INSTANCE_PATH, `${seeded}${linked.yaml}`, { branch: 'main' })
        }

        const shapeBranch = await provider.resolveBranch(ctx, 'shape')
        const soapTexts = {}
        for (const moduleId of SHAPE_MODULES) {
          soapTexts[moduleId] = exampleModuleText(moduleId)
          await client.writeFile(MODULE_PATH(moduleId), soapTexts[moduleId], { branch: shapeBranch })
        }
        await client.writeFile(DOC('Solution on a Page'), 'rendered soap', { branch: shapeBranch })

        const soapOpened = await post(`/api/instance/request-approval?slug=${SLUG}`)
        assert.equal(typeof soapOpened.pullRequestId, 'number', JSON.stringify(soapOpened))
        await provider.vote(ctx, soapOpened.pullRequestId, provider.people.soapOwner, 'approve')
        const soapApproved = await post(`/api/instance/check-status?slug=${SLUG}`)
        assert.equal(soapApproved.merged, true, JSON.stringify(soapApproved))
        assert.equal(soapApproved.advancedTo.id, 'hld-define')
        await provider.afterSoapMerged?.(ctx, client)

        const writeOnHld = async (moduleId, text) => {
          const hldBranch = await provider.resolveBranch(ctx, 'hld-define')
          await client.writeFile(MODULE_PATH(moduleId), text, { branch: hldBranch })
        }
        // HLD fills its gate and rewords a Field SOAP prints, then renders its document.
        const prepareHld = async () => {
          for (const moduleId of HLD.modules) {
            if (SHAPE_MODULES.includes(moduleId)) continue
            await writeOnHld(moduleId, exampleModuleText(moduleId))
          }
          await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'Reworded during HLD review.'))
          const hldBranch = await provider.resolveBranch(ctx, 'hld-define')
          await client.writeFile(DOC('High Level Design'), 'rendered hld', { branch: hldBranch })
          // #276: the SOAP document this approval also re-approves has to be re-rendered on HLD's branch first.
          const rerendered = await post(`/api/instance/rerender-earlier/soap?slug=${SLUG}`)
          assert.equal(rerendered.artefact, 'soap', JSON.stringify(rerendered))
        }
        await fn({ ctx, provider, client, get, post, soapOpened, soapTexts, writeOnHld, prepareHld, linked })
      },
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

for (const providerId of Object.keys(PROVIDERS)) {
  const { name } = PROVIDERS[providerId]

  test(`${name}: a stage with nothing changed under an earlier stage re-approves nothing`, async () => {
    await withApprovedSoap(providerId, async ({ soapOpened, provider, ctx }) => {
      // SOAP is the first stage: it opened with no re-approval listed anywhere.
      assert.equal(soapOpened.alsoReapproves, undefined)
      const { description } = await provider.pullRequest(ctx, soapOpened.pullRequestId)
      assert.doesNotMatch(description, /re-approves/)
    })
  })

  test(`${name}: Request approval lists the earlier stage's changed Fields in the Pull Request and adds that stage's approver as a required reviewer`, async () => {
    await withApprovedSoap(providerId, async ({ ctx, provider, post, prepareHld }) => {
      await prepareHld()
      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      assert.equal(typeof opened.pullRequestId, 'number', JSON.stringify(opened))

      assert.equal(opened.alsoReapproves.length, 1)
      const [entry] = opened.alsoReapproves
      assert.equal(entry.stageId, 'shape')
      assert.equal(entry.title, SHAPE.title)
      assert.ok(entry.fields.includes('background.problem'), 'the reworded Field is listed')
      assert.equal(entry.count, entry.fields.length)
      assert.deepEqual(entry.reviewers.map((r) => r.displayName), [provider.names.soapOwner])

      const { description, requested } = await provider.pullRequest(ctx, opened.pullRequestId)
      assert.match(description, /also re-approves earlier stages/)
      assert.ok(description.includes(`**${SHAPE.title}**`), 'names the earlier stage')
      assert.match(description, /Background and context: Problem statement/, 'lists the Field by its module and title')
      assert.ok(description.includes(provider.names.soapOwner), 'names who must approve again')
      // The earlier stage's approver joins HLD's own reviewer.
      assert.ok(requested.includes(provider.people.soapOwner), `SOAP's approver is a requested reviewer: ${requested}`)
      assert.ok(requested.includes(provider.people.hldOwner), `HLD's own reviewer is still there: ${requested}`)

      // The Sign-off panel on the HLD stage shows what its open Pull Request also re-approves.
      const { alsoReapproving } = await (await fetch(`${ctx.gantryBase}/api/instance?slug=${SLUG}`, { headers: provider.auth() })).json()
      assert.deepEqual(alsoReapproving.map((e) => e.stageId), ['shape'])
    })
  })

  test(`${name}: Check status waits for both reviewers, waits while the earlier stage's reviewer asks for changes, then merges and records the re-approval`, async () => {
    await withApprovedSoap(providerId, async ({ ctx, provider, get, post, prepareHld }) => {
      await prepareHld()
      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      const prId = opened.pullRequestId
      const { people, names } = provider
      const check = () => post(`/api/instance/check-status?slug=${SLUG}`)

      // Nobody has voted.
      let result = await check()
      assert.equal(result.merged, false)
      assert.equal(result.review.state, 'pending')

      // HLD's own reviewer approves; SOAP's reviewer has not. It must not merge.
      await provider.vote(ctx, prId, people.hldOwner, 'approve')
      result = await check()
      assert.equal(result.merged, false, JSON.stringify(result))
      assert.equal(result.prStatus, 'active')
      assert.equal(result.review.state, 'pending', 'one vote is not enough')
      assert.deepEqual(result.waitingForReviewers.map((w) => [w.displayName, w.forStages]), [[names.soapOwner, [SHAPE.title]]])
      assert.match(result.message, new RegExp(`Waiting for ${names.soapOwner}`))
      assert.equal(result.pullRequest.review.state, 'pending', 'the panel summary reads the same')

      // Somebody else approving does not stand in for SOAP's reviewer.
      await provider.vote(ctx, prId, people.bystander, 'approve')
      result = await check()
      assert.equal(result.merged, false)
      assert.equal(result.waitingForReviewers.length, 1)

      // SOAP's reviewer asks for changes: the stage waits.
      await provider.vote(ctx, prId, people.soapOwner, 'changes')
      result = await check()
      assert.equal(result.merged, false)
      assert.match(result.review.state, /changes-requested|rejected/)

      // SOAP's reviewer approves: both votes are in, and it merges.
      await provider.vote(ctx, prId, people.soapOwner, 'approve')
      result = await check()
      assert.equal(result.merged, true, JSON.stringify(result))
      assert.equal(result.waitingForReviewers, undefined)
      const [reapproval] = result.reapproved.reapprovals
      assert.equal(reapproval.stageId, 'shape')
      assert.equal(reapproval.by, 'hld-define')
      assert.equal(reapproval.pullRequestId, prId)
      assert.ok(reapproval.fields.includes('background.problem'))
      assert.equal(typeof reapproval.approvedAt, 'string')

      // The earlier stage keeps its original approval and gains the re-approval entry.
      const soap = await get(`/api/instance?slug=${SLUG}&stage=shape`)
      assert.equal(soap.reapprovals.length, 1)
      assert.deepEqual(
        { by: soap.reapprovals[0].by, byTitle: soap.reapprovals[0].byTitle, pullRequestId: soap.reapprovals[0].pullRequestId },
        { by: 'hld-define', byTitle: HLD.title, pullRequestId: prId }
      )
      assert.deepEqual(soap.reapprovals[0].reviewers.map((r) => r.displayName), [names.soapOwner])
      assert.ok(soap.reapprovals[0].fields.includes('background.problem'))
      assert.equal(typeof soap.reapprovals[0].approvedAt, 'string')

      // ...and its flag clears: the content is now what the merge approved.
      assert.deepEqual(soap.changedSinceApproval, [])
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval, [])

      // A second Check status finds nothing left to stamp.
      const again = await check()
      assert.equal(again.reapproved, undefined)
    })
  })

  test(`${name}: only an edit made after the re-approval merged flags the earlier stage again`, async () => {
    await withApprovedSoap(providerId, async ({ ctx, provider, get, post, prepareHld, soapTexts }) => {
      await prepareHld()
      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      // While the re-approval is still open the earlier stage stays flagged: its approved content hasn't moved.
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval.map((e) => e.stageId), ['shape'])

      await provider.vote(ctx, opened.pullRequestId, provider.people.hldOwner, 'approve')
      await provider.vote(ctx, opened.pullRequestId, provider.people.soapOwner, 'approve')
      assert.equal((await post(`/api/instance/check-status?slug=${SLUG}`)).merged, true)
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval, [])

      // Back on `main`, a later edit to a Field SOAP prints is a change since the re-approval.
      await provider.client(ctx).writeFile(MODULE_PATH('background'), withFieldText(soapTexts.background, 'Problem statement', 'Edited again after the re-approval.'), { branch: 'main' })
      const [entry] = (await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval
      assert.equal(entry.stageId, 'shape')
      assert.deepEqual(entry.fields, ['background.problem'])
    })
  })

  test(`${name}: a linked work item gets a comment once the re-approval merges`, async () => {
    await withApprovedSoap(
      providerId,
      async ({ ctx, provider, post, prepareHld, linked }) => {
        await prepareHld()
        const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
        await provider.vote(ctx, opened.pullRequestId, provider.people.hldOwner, 'approve')
        await provider.vote(ctx, opened.pullRequestId, provider.people.soapOwner, 'approve')
        const result = await post(`/api/instance/check-status?slug=${SLUG}`)
        assert.equal(result.merged, true, JSON.stringify(result))
        assert.deepEqual(result.reapproved.workItemSync.map((s) => [s.ok, s.stageId, s.workItemId]), [[true, 'shape', linked.shapeItem]])

        const notes = await linked.read(linked.shapeItem)
        assert.equal(notes.length, 1, `exactly one note on the SOAP work item: ${JSON.stringify(notes)}`)
        assert.match(notes[0], /Stage 'shape'/)
        assert.match(notes[0], /was re-approved/)
        assert.match(notes[0], /stage 'hld-define'/)
        assert.ok(notes[0].includes(`Pull Request #${opened.pullRequestId}`))
        assert.ok(notes[0].includes('background.problem'))
        assert.ok(notes[0].includes(provider.names.soapOwner))

        // Asking again comments nowhere further.
        await post(`/api/instance/check-status?slug=${SLUG}`)
        assert.equal((await linked.read(linked.shapeItem)).length, 1)
      },
      { linkWorkItems: true }
    )
  })
}

test('a local workspace never reports a re-approval', async () => {
  const { withRunningExamplesServer } = await import('./helpers/lifecycle.js')
  await withRunningExamplesServer({}, async (base) => {
    const instance = await (await fetch(`${base}/api/instance?slug=examples`)).json()
    assert.deepEqual(instance.reapprovals, [])
    assert.deepEqual(instance.alsoReapproving, [])
  })
})
