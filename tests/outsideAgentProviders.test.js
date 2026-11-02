import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveGitHubStageBranch, stageBranchName as githubStageBranchName } from '../lib/githubStageBranch.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { recordInstancePullRequest } from '../lib/instance.js'
import { withRunningServerForProvider, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// #307 (docs/adr/0067): an outside agent in an AI interview session on Azure DevOps and GitHub workspaces, where a Stage moves on by Pull
// Request. A session Save is one commit on the Stage's branch that carries the content, the labelled entries and the session status; the
// brief and recap are read from the Stage's branch; and the agent is held to the in-app AI's rules with the in-app AI's reasons: it never
// passes a Gate, requests approvals in Stage order and does not write a Module an earlier Stage with an open Pull Request also mounts.
// Same Definition and set-up as tests/serverDraftAhead.test.js.

const SLUG = 'drafting-ahead'
const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages
const SHARED = 'background'
const HEAD_START = 'risks'
const SESSION = { id: 's-agent2', runUntil: HLD_DEFINE.id, state: 'in-progress', model: 'claude-opus-4-1', who: 'a.architect' }

const seedFiles = () => ({ [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${SHAPE.id}\ndefinitionVersion: 2\n` })
const json = { 'Content-Type': 'application/json' }

async function withScratchServer(provider, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(provider, { options: { instancesDir }, fakeServerOptions: { files: seedFiles() } }, (ctx) => fn({ ...ctx, instancesDir }))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const PROVIDERS = [
  {
    name: 'GitHub',
    provider: 'github',
    auth: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    register: (instancesDir, baseUrl) => registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, { instancesDir }),
    location: (baseUrl) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl }),
    key: 'github',
    resolve: resolveGitHubStageBranch,
    client: (location) => createGitHubClient(location),
    branchName: githubStageBranchName,
  },
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    auth: { Authorization: basicAuthHeader(VALID_PAT) },
    register: (instancesDir, baseUrl) => registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }, { instancesDir }),
    location: (baseUrl) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }),
    key: 'azureDevOps',
    resolve: resolveStageBranch,
    client: (location) => createAzureDevOpsClient(location),
    branchName: stageBranchName,
  },
]

for (const spec of PROVIDERS) {
  async function setUp({ gantryBase, providerBaseUrl, instancesDir }) {
    spec.register(instancesDir, providerBaseUrl)
    const location = spec.location(providerBaseUrl)
    const shapeBranch = await spec.resolve(location, definition, SLUG, SHAPE.id)
    await recordInstancePullRequest(SLUG, SHAPE.id, 41, { [spec.key]: { ...location, branch: shapeBranch }, pullRequestStatus: 'active' })
    const api = (method, path, body, stage = HLD_DEFINE.id) =>
      fetch(`${gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}${stage ? `&stage=${stage}` : ''}`, { method, headers: { ...spec.auth, ...json }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { location, client: spec.client(location), api }
  }

  test(`${spec.name}: a session Save of the head start is one commit on the Stage's branch with the content, the labelled entries and the session status`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { client, api } = await setUp(ctx)
      const version = (await (await api('GET', '/api/instance')).json()).stageVersion
      assert.equal(typeof version, 'string')

      const missing = await api('PUT', '/api/instance/modules', { modules: { [HEAD_START]: { fields: { 'risk-register': 'Words.' } } }, session: SESSION })
      assert.equal(missing.status, 400)
      assert.equal((await missing.json()).code, 'stage_version_required')
      assert.equal(await client.branchExists(spec.branchName(SLUG, HLD_DEFINE.id)), false, 'a refused Save starts no branch')

      const saved = await api('PUT', '/api/instance/modules', {
        modules: { [HEAD_START]: { status: 'draft', fields: { 'risk-register': 'Vendor lock-in is the main risk.' } } },
        baseVersion: version,
        session: { ...SESSION, state: 'head-start' },
        entries: [{ kind: 'answer', question: 'What is the main risk?', answer: ['Vendor lock-in'], fields: [`${HEAD_START}.risk-register`] }],
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      assert.deepEqual((await saved.json()).session, { id: SESSION.id, state: 'head-start', recordedBy: 'outside agent', entriesRecorded: 1 })

      const branch = spec.branchName(SLUG, HLD_DEFINE.id)
      assert.match(await client.getFileContent(`gantry-workspace/${SLUG}/modules/${HEAD_START}.md`, { branch }), /Vendor lock-in/)
      const log = parseYaml(await client.getFileContent(`gantry-workspace/${SLUG}/interview/${HLD_DEFINE.id}.yaml`, { branch }))
      assert.equal(log.entries[0].recordedBy, 'outside agent')
      assert.equal(log.entries[0].agentModel, 'claude-opus-4-1')
      assert.equal(log.status[0].state, 'head-start')
      assert.deepEqual(log.status[0].models, [{ type: 'outside-agent', model: 'claude-opus-4-1', tokens: 'not reported' }])
      assert.deepEqual(log.fields[`${HEAD_START}.risk-register`].entries, [log.entries[0].id])
    })
  })

  test(`${spec.name}: the brief and the recap are read from the Stage's branch, and a paused session is offered to take over`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { api } = await setUp(ctx)
      const version = (await (await api('GET', '/api/instance')).json()).stageVersion
      const paused = await api('PUT', `/api/instance/decisions?stage=${HLD_DEFINE.id}`, { session: { ...SESSION, state: 'paused' }, entries: [{ kind: 'open-question', question: 'Which cloud?', fields: [`${HEAD_START}.risk-register`] }] }, null)
      assert.equal(paused.status, 200, await paused.clone().text())
      assert.ok(version)
      const brief = await (await api('GET', '/api/instance/interview-brief?who=a.architect')).json()
      assert.equal(brief.stage.id, HLD_DEFINE.id)
      assert.equal(brief.recap.resuming, true)
      assert.equal(brief.recap.adoptable.session, SESSION.id)
      assert.equal(brief.recap.openQuestions[0].question, 'Which cloud?')
      assert.match(brief.brief, /Which cloud\?/)
      // The Stage is drafted ahead of Shape, whose Pull Request is open: the shared Modules are held, and the brief says so.
      assert.ok(brief.heldModules.some((h) => h.id === SHARED))
      assert.match(brief.brief, /Head start only/)
    })
  })

  test(`${spec.name}: a write to a Module an earlier Stage with an open Pull Request also mounts is refused with the same reason in a session and outside one`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { api } = await setUp(ctx)
      const version = (await (await api('GET', '/api/instance')).json()).stageVersion
      const modules = { [SHARED]: { status: 'draft', fields: { summary: 'Words.' } } }
      const outside = await api('PUT', '/api/instance/modules', { modules })
      const inSession = await api('PUT', '/api/instance/modules', { modules, baseVersion: version, session: SESSION, entries: [{ kind: 'open-question', question: 'Q?' }] })
      assert.equal(outside.status, 400)
      assert.equal(inSession.status, 400)
      const [a, b] = [await outside.json(), await inSession.json()]
      assert.equal(a.code, 'shared-module-pending')
      assert.deepEqual(b, a, 'the in-app AI\'s reason, word for word')
      assert.match(b.error, /\(background\) with Stage "SOAP" \(shape\)/)
    })
  })

  test(`${spec.name}: an agent in a session never passes a Gate; outside a session the answer is as it was`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { api } = await setUp(ctx)
      const inSession = await api('POST', `/api/instance/advance-stage?session=${SESSION.id}`, undefined, null)
      assert.equal(inSession.status, 400)
      const refused = await inSession.json()
      assert.equal(refused.code, 'session-guard')
      assert.match(refused.error, /never passes a Gate: a Gate that needs approval or review stops it/)
      assert.match(refused.error, /moves on only when its Pull Request is approved and merged/)
      const outside = await api('POST', '/api/instance/advance-stage', undefined, null)
      assert.equal(outside.status, 400)
      assert.match((await outside.json()).error, /Workspace-backed — it advances to its next stage only once that stage's own Pull Request is merged/)
    })
  })

  test(`${spec.name}: approvals go in Stage order whether or not the agent is in a session, with the same reason; a session must have saved the current Stage first`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { api } = await setUp(ctx)
      const out = await api('POST', `/api/instance/request-approval?session=${SESSION.id}`, { gate: HLD_DEFINE.gate }, null)
      const plain = await api('POST', '/api/instance/request-approval', { gate: HLD_DEFINE.gate }, null)
      assert.equal(out.status, 400)
      assert.equal(plain.status, 400)
      const reason = (await plain.json()).error
      assert.deepEqual((await out.json()).error, reason, 'the in-app AI\'s reason, word for word')
      assert.match(reason, /stages are approved in order/)

      // The current Stage, asked for approval by a session that has not saved it: refused before a Pull Request is opened.
      const unsaved = await api('POST', `/api/instance/request-approval?session=${SESSION.id}`, {}, null)
      assert.equal(unsaved.status, 400)
      const body = await unsaved.json()
      assert.equal(body.code, 'session-guard')
      assert.match(body.error, /asks for approval only after the architect confirmed the stage summary/)
    })
  })
}
