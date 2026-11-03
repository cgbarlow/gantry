import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { basicAuthHeader, withRunningServerForProvider, ORGANIZATION, PROJECT, REPOSITORY, GITHUB_OWNER, GITHUB_REPOSITORY } from './helpers/lifecycle.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #295 (map #238, docs/adr/0063 and 0064): the decisions log on Azure DevOps and GitHub workspaces, and the **Approval queued** hand-over.
// The log is `interview/<stageId>.yaml` on the Stage's own branch, written in the same commit as the Stage's Modules (or alone, for a
// Pause), and the Check status that sees an earlier Stage merge opens the Pull Request of a Stage the AI interview queued.

const SLUG = 'remote-trio'
const ROOT = `gantry-workspace/${SLUG}`
const INSTANCE_YAML = `definition: trio\nslug: ${SLUG}\nstage: s1\ndefinitionVersion: 1\n`
const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    kind: 'azureDevOps',
    author: 'Fake Pusher',
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/pushes$/.test(path),
    // The Owner's approval, cast directly at the Provider (Gantry never votes, ADR-0014).
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ctx.pat), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
      }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    kind: 'github',
    author: 'Fake Author',
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/git\/commits$/.test(path),
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      }),
  },
]

// Counts the commits the server asks a Provider to make while `fn` runs (the server shares this process's fetch).
async function countingCommits(commitRequest, fn) {
  const realFetch = globalThis.fetch
  let commits = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (commitRequest((init?.method ?? 'GET').toUpperCase(), url.pathname)) commits++
    return realFetch(input, init)
  }
  try {
    await fn()
  } finally {
    globalThis.fetch = realFetch
  }
  return commits
}

async function withTrio(spec, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-295-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    await withRunningServerForProvider(
      spec.provider,
      { options: { instancesDir, definitionsDir }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
      async (ctx) => {
        registerInstance(SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const api = (path, init = {}) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })
        await fn({ ctx, api, client: spec.client(ctx) })
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const status = (state, over = {}) => ({ session: 's-1', who: 'a.architect', target: 's2', state, ...over })
const answer = (id) => ({ id, kind: 'answer', at: '2026-11-02T10:00:00.000Z', session: 's-1', question: `Question ${id}`, answer: ['Yes'], fields: ['m1.body'] })
const saveModules = (api, stage, decisions, body = `Notes for ${stage}: the agreed position.`) =>
  api(`/api/instance/modules?stage=${stage}`, json('PUT', { modules: { [`m${stage.slice(1)}`]: { status: 'draft', owner: '', fields: { body } } }, ...(decisions ? { decisions } : {}) }))

for (const spec of PROVIDERS) {
  describe(`${spec.name}: the decisions log and Approval queued`, () => {
    test("a stage Save writes the Stage's decisions log in the same commit as its Modules, on the Stage's branch", async () => {
      await withTrio(spec, async ({ api, client }) => {
        const branch = stageBranchName(SLUG, 's1')
        assert.equal(await client.branchExists(branch), false)
        const empty = await (await api('/api/instance/decisions')).json()
        assert.deepEqual(empty.log.entries, [])
        assert.equal(empty.lastSaved, null, 'a Stage with no branch has no one who saved it')
        assert.equal(await client.branchExists(branch), false, 'a read starts no branch')

        let res
        const commits = await countingCommits(spec.commitRequest, async () => {
          res = await saveModules(api, 's1', { status: status('awaiting-approval'), entries: [answer('s-1-1')] })
        })
        assert.equal(res.status, 200, await res.clone().text())
        assert.equal(commits, 1, 'the content and its log are one commit')
        assert.match(await client.getFileContent(`${ROOT}/modules/m1.md`, { branch }), /Notes for s1/)
        const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch }))
        assert.deepEqual(log.entries.map((e) => e.id), ['s-1-1'])
        assert.deepEqual([log.status[0].state, log.status[0].target], ['awaiting-approval', 's2'])
        assert.equal(await client.fileExists(`${ROOT}/interview/s1.yaml`, 'main'), false, 'main is untouched until the Stage is approved')

        // A read finds it again, and says who last saved the Stage: the commit author.
        const read = await (await api('/api/instance/decisions?stage=s1')).json()
        assert.deepEqual(read.log.entries.map((e) => e.id), ['s-1-1'])
        assert.equal(read.lastSaved.by, spec.author)
        assert.ok(read.lastSaved.at)
      })
    })

    test('a Pause saves the log alone as one commit, entries are only appended, and a refused change starts and writes nothing', async () => {
      await withTrio(spec, async ({ api, client }) => {
        const branch = stageBranchName(SLUG, 's1')
        let res
        const commits = await countingCommits(spec.commitRequest, async () => {
          res = await api('/api/instance/decisions?stage=s1', json('PUT', { decisions: { status: status('paused'), entries: [answer('s-1-1')] } }))
        })
        assert.equal(res.status, 200, await res.clone().text())
        assert.equal(commits, 1)
        assert.equal(await client.branchExists(branch), true)
        assert.equal(await client.fileExists(`${ROOT}/modules/m1.md`, branch), false, 'only the log was written')

        const more = await api('/api/instance/decisions?stage=s1', json('PUT', { decisions: { status: status('paused'), entries: [answer('s-1-2')] } }))
        assert.deepEqual((await more.json()).log.entries.map((e) => e.id), ['s-1-1', 's-1-2'])

        // Changing an entry is refused (409) and the Save that carried it writes no Module either.
        const changed = await saveModules(api, 's1', { entries: [{ ...answer('s-1-1'), answer: ['No'] }] })
        assert.equal(changed.status, 409)
        assert.equal(await client.fileExists(`${ROOT}/modules/m1.md`, branch), false)
        const kept = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch }))
        assert.deepEqual(kept.entries.map((e) => [e.id, e.answer]), [['s-1-1', ['Yes']], ['s-1-2', ['Yes']]])
      })
    })

    test("a later Stage's log is on its own branch and never touches an earlier Stage's", async () => {
      await withTrio(spec, async ({ api, client }) => {
        assert.equal((await saveModules(api, 's1', { status: status('awaiting-approval') })).status, 200)
        assert.equal((await saveModules(api, 's2', { status: status('approval-queued', { session: 's-2' }) })).status, 200)
        const s1 = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch: stageBranchName(SLUG, 's1') }))
        const s2 = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: stageBranchName(SLUG, 's2') }))
        assert.deepEqual([s1.stage, s1.status[0].state], ['s1', 'awaiting-approval'])
        assert.deepEqual([s2.stage, s2.status[0].state], ['s2', 'approval-queued'])
        // The stacked branch carries the earlier Stage's file as it was cut, and does not rewrite it.
        const read = await (await api('/api/instance/decisions?stage=s2')).json()
        assert.equal(read.log.stage, 's2')
      })
    })

    test('a Stage queued while an earlier one is pending opens its Pull Request when Check status sees the earlier one merge', async () => {
      await withTrio(spec, async ({ ctx, api }) => {
        assert.equal((await saveModules(api, 's1', { status: status('awaiting-approval') })).status, 200)
        const first = await api('/api/instance/request-approval', json('POST', {}))
        assert.equal(first.status, 200, await first.clone().text())
        const firstPr = (await first.json()).pullRequestId

        // Shape is ready while Scope is pending: it can't ask yet, so the AI interview queues it.
        assert.equal((await saveModules(api, 's2', { status: status('approval-queued', { session: 's-2' }) })).status, 200)
        const refused = await api('/api/instance/request-approval', json('POST', { gate: 'g2' }))
        assert.equal(refused.status, 400)
        assert.match((await refused.json()).error, /Scope|s1/, 'it names the Stage that is current')

        // Nothing has been opened for Shape, and a Check status that sees Scope still pending opens nothing.
        let instance = await (await api('/api/instance')).json()
        assert.equal(instance.pullRequests.s2, undefined)
        const pending = await (await api('/api/instance/check-status', json('POST', {}))).json()
        assert.equal(pending.merged, false)
        assert.equal(pending.queuedApproval, undefined)

        // The Owner approves Scope; the Check status that merges it also opens Shape's Pull Request.
        assert.equal((await spec.approve(ctx, firstPr)).status < 300, true)
        const merged = await (await api('/api/instance/check-status', json('POST', {}))).json()
        assert.equal(merged.merged, true)
        assert.equal(merged.advancedTo.id, 's2')
        assert.equal(merged.queuedApproval.opened, true, JSON.stringify(merged.queuedApproval))
        assert.equal(merged.queuedApproval.stage.id, 's2')
        instance = await (await api('/api/instance')).json()
        assert.equal(instance.currentStageId, 's2')
        assert.equal(instance.pullRequests.s2, merged.queuedApproval.pullRequestId)
        assert.notEqual(instance.pullRequests.s2, firstPr)
      })
    })

    test('a Stage that was not queued gets no Pull Request from the Check status that merges the one before it', async () => {
      await withTrio(spec, async ({ ctx, api }) => {
        assert.equal((await saveModules(api, 's1', { status: status('awaiting-approval') })).status, 200)
        const firstPr = (await (await api('/api/instance/request-approval', json('POST', {}))).json()).pullRequestId
        assert.equal((await saveModules(api, 's2', { status: status('paused', { session: 's-2' }) })).status, 200)
        await spec.approve(ctx, firstPr)
        const merged = await (await api('/api/instance/check-status', json('POST', {}))).json()
        assert.equal(merged.merged, true)
        assert.equal(merged.queuedApproval, undefined)
        const instance = await (await api('/api/instance')).json()
        assert.equal(instance.pullRequests.s2, undefined)
      })
    })

    test("a queued Stage whose Gate no longer passes stays queued: the merge is kept and the response says why", async () => {
      await withTrio(spec, async ({ ctx, api }) => {
        assert.equal((await saveModules(api, 's1', { status: status('awaiting-approval') })).status, 200)
        const firstPr = (await (await api('/api/instance/request-approval', json('POST', {}))).json()).pullRequestId
        // Shape is queued, but its Field has been emptied since.
        assert.equal((await saveModules(api, 's2', { status: status('approval-queued', { session: 's-2' }) }, '')).status, 200)
        await spec.approve(ctx, firstPr)
        const merged = await (await api('/api/instance/check-status', json('POST', {}))).json()
        assert.equal(merged.merged, true)
        assert.equal(merged.advancedTo.id, 's2')
        assert.equal(merged.queuedApproval.opened, false)
        assert.match(merged.queuedApproval.error, /not passed|outstanding/i)
        const instance = await (await api('/api/instance')).json()
        assert.equal(instance.pullRequests.s2, undefined)
      })
    })
  })
}
