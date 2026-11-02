import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import {
  withRunningServerForProvider,
  withRunningExamplesServer,
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

// #273, ADR-0069 — "changed since approval" on a remote (Pull Request approved) Instance. Real HTTP
// against a real gantry server and a real in-process fake of each provider, for GitHub and Azure DevOps.
//
// The scenario: SOAP (`shape`) is approved and merged, so the Instance moves on to HLD (`hld-define`).
// `background` is mounted at both. SOAP prints `background.problem` (its `requires` lists name it);
// only HLD prints `background.success-criteria`. So editing the first from HLD changes approved SOAP
// content, and editing the second does not.

const SLUG = 'changed-since-approval'
const definition = loadDefinition('design', { version: 2 })
const SHAPE = definition.stages.find((s) => s.id === 'shape')
const HLD = definition.stages.find((s) => s.id === 'hld-define')
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']
const MODULE_PATH = (moduleId) => `gantry-workspace/${SLUG}/modules/${moduleId}.md`
const INSTANCE_YAML = `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n`

// Replaces one Field's body in a module file's text (Fields are `## <title>` sections).
function withFieldText(text, title, body) {
  const heading = `## ${title}`
  const start = text.indexOf(`${heading}\n`)
  assert.notEqual(start, -1, `module text has a "${title}" section`)
  const bodyStart = start + heading.length + 1
  const next = text.indexOf('\n## ', bodyStart)
  return `${text.slice(0, bodyStart)}\n${body}\n${next === -1 ? '' : text.slice(next)}`
}

const PROVIDERS = {
  github: {
    name: 'GitHub',
    kind: 'github',
    seed: () => ({ [`/gantry-workspace/${SLUG}/instance.yaml`]: INSTANCE_YAML }),
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    credentials: (ctx) => ({ ...PROVIDERS.github.location(ctx), pat: GITHUB_VALID_PAT }),
    client: (ctx) => createGitHubClient(PROVIDERS.github.credentials(ctx)),
    resolveBranch: (ctx, stageId) => resolveGitHubStageBranch(PROVIDERS.github.credentials(ctx), definition, SLUG, stageId),
    auth: () => ({ Authorization: basicAuthHeader(GITHUB_VALID_PAT) }),
    approve: async (ctx, pullRequestId) => {
      await fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      })
    },
  },
  'azure-devops': {
    name: 'Azure DevOps',
    kind: 'azureDevOps',
    seed: () => ({ [`/gantry-workspace/${SLUG}/instance.yaml`]: INSTANCE_YAML }),
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    credentials: (ctx) => ({ ...PROVIDERS['azure-devops'].location(ctx), pat: VALID_PAT }),
    client: (ctx) => createAzureDevOpsClient(PROVIDERS['azure-devops'].credentials(ctx)),
    resolveBranch: (ctx, stageId) => resolveStageBranch(PROVIDERS['azure-devops'].credentials(ctx), definition, SLUG, stageId),
    auth: () => ({ Authorization: basicAuthHeader(VALID_PAT) }),
    approve: async (ctx, pullRequestId) => {
      await fetch(
        `${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
        {
          method: 'PUT',
          headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
        }
      )
    },
  },
}

// Runs `fn(env)` against a fresh server+fake pair with SOAP approved and merged and the Instance at HLD.
async function withApprovedSoap(providerId, fn) {
  const provider = PROVIDERS[providerId]
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(
      providerId,
      { options: { instancesDir }, fakeServerOptions: { files: provider.seed() } },
      async (ctx) => {
        registerInstance(SLUG, { kind: provider.kind, ...provider.location(ctx) }, { instancesDir })
        const client = provider.client(ctx)
        const headers = provider.auth()
        const get = async (path) => (await fetch(`${ctx.gantryBase}${path}`, { headers })).json()
        const post = async (path) => (await fetch(`${ctx.gantryBase}${path}`, { method: 'POST', headers })).json()

        const shapeBranch = await provider.resolveBranch(ctx, 'shape')
        const soapTexts = {}
        for (const moduleId of SHAPE_MODULES) {
          soapTexts[moduleId] = exampleModuleText(moduleId)
          await client.writeFile(MODULE_PATH(moduleId), soapTexts[moduleId], { branch: shapeBranch })
        }
        await client.writeFile(`gantry-workspace/${SLUG}/out/Changed Since Approval - Solution on a Page.docx`, 'rendered soap', { branch: shapeBranch })

        const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
        assert.equal(typeof opened.pullRequestId, 'number')
        await provider.approve(ctx, opened.pullRequestId)
        const approved = await post(`/api/instance/check-status?slug=${SLUG}`)
        assert.equal(approved.merged, true)
        assert.equal(approved.advancedTo.id, 'hld-define')

        // Writes a module onto HLD's own branch (created from main on first use), as the editor's Save does.
        const writeOnHld = async (moduleId, text) => {
          const hldBranch = await provider.resolveBranch(ctx, 'hld-define')
          await client.writeFile(MODULE_PATH(moduleId), text, { branch: hldBranch })
        }
        await fn({ ctx, provider, client, get, post, soapTexts, writeOnHld, instancesDir, headers })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

for (const providerId of Object.keys(PROVIDERS)) {
  const { name } = PROVIDERS[providerId]

  test(`${name}: nothing is flagged straight after SOAP is approved`, async () => {
    await withApprovedSoap(providerId, async ({ get }) => {
      const instance = await get(`/api/instance?slug=${SLUG}`)
      assert.equal(instance.currentStageId, 'hld-define')
      assert.deepEqual(instance.changedSinceApproval, [])
    })
  })

  test(`${name}: a later stage changing a Field SOAP prints flags SOAP, and restoring the wording clears it`, async () => {
    await withApprovedSoap(providerId, async ({ get, soapTexts, writeOnHld }) => {
      const edited = withFieldText(soapTexts.background, 'Problem statement', 'Reworded during HLD review.')
      await writeOnHld('background', edited)

      const instance = await get(`/api/instance?slug=${SLUG}`)
      assert.deepEqual(
        instance.changedSinceApproval.map(({ stageId, title, fields, count }) => ({ stageId, title, fields, count })),
        [{ stageId: 'shape', title: SHAPE.title, fields: ['background.problem'], count: 1 }]
      )
      assert.equal(typeof instance.changedSinceApproval[0].pullRequestId, 'number')

      // The flag is about the Instance, so the earlier stage's own tab reports it too.
      const soapView = await get(`/api/instance?slug=${SLUG}&stage=shape`)
      assert.deepEqual(soapView.changedSinceApproval.map((e) => e.stageId), ['shape'])

      await writeOnHld('background', soapTexts.background)
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval, [])
    })
  })

  test(`${name}: a change to a Field only a later Artefact prints does not raise the flag`, async () => {
    await withApprovedSoap(providerId, async ({ get, soapTexts, writeOnHld }) => {
      // `background.success-criteria` is printed by the HLD alone — no SOAP Artefact lists it.
      const edited = withFieldText(soapTexts.background, 'Success criteria', 'Only the HLD prints this.')
      await writeOnHld('background', edited)
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval, [])
    })
  })

  test(`${name}: counts every changed Field, and whitespace-only edits are not changes`, async () => {
    await withApprovedSoap(providerId, async ({ get, soapTexts, writeOnHld }) => {
      let edited = withFieldText(soapTexts.background, 'Problem statement', 'First change.')
      edited = withFieldText(edited, 'Affected domains', 'Second change.')
      await writeOnHld('background', edited)
      const [entry] = (await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval
      assert.deepEqual(entry.fields, ['background.problem', 'background.affected-domains'])
      assert.equal(entry.count, 2)

      await writeOnHld('background', `${soapTexts.background.trimEnd()}\n\n\n`)
      assert.deepEqual((await get(`/api/instance?slug=${SLUG}`)).changedSinceApproval, [])
    })
  })

  test(`${name}: a change already on main that no re-approval covered flags the earlier stage with no stage branch involved`, async () => {
    await withApprovedSoap(providerId, async ({ get, client, soapTexts }) => {
      // Stands in for an Instance approved before this rule existed: the only thing recorded is the
      // approved stage's Pull Request, and `main` has since moved on without a re-approval.
      await client.writeFile(MODULE_PATH('background'), withFieldText(soapTexts.background, 'Problem statement', 'Edited straight on main.'), { branch: 'main' })
      const instance = await get(`/api/instance?slug=${SLUG}`)
      assert.deepEqual(instance.changedSinceApproval.map((e) => [e.stageId, e.fields]), [['shape', ['background.problem']]])
    })
  })

  test(`${name}: the dashboard row carries the flag by stage and Field count`, async () => {
    await withApprovedSoap(providerId, async ({ get, ctx, soapTexts, writeOnHld, headers }) => {
      const row = async () => (await (await fetch(`${ctx.gantryBase}/api/instances`, { headers })).json()).find((r) => r.slug === SLUG)
      assert.deepEqual((await row()).changedSinceApproval, [])

      await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'Changed at HLD.'))
      assert.deepEqual((await row()).changedSinceApproval, [{ stageId: 'shape', title: SHAPE.title, count: 1 }])
      assert.equal((await get(`/api/instance?slug=${SLUG}`)).stage.id, HLD.id)
    })
  })
}

for (const providerId of Object.keys(PROVIDERS)) {
  test(`${PROVIDERS[providerId].name}: Check status carries the flag in its response, which is what MCP check_status returns`, async () => {
    await withApprovedSoap(providerId, async ({ ctx, provider, client, post, soapTexts, writeOnHld }) => {
      // Give HLD enough to pass its gate and open its own Pull Request, so Check status has one to read.
      for (const moduleId of definition.stages.find((s) => s.id === 'hld-define').modules) {
        if (SHAPE_MODULES.includes(moduleId)) continue
        await writeOnHld(moduleId, exampleModuleText(moduleId))
      }
      const hldBranch = await provider.resolveBranch(ctx, 'hld-define')
      await client.writeFile(`gantry-workspace/${SLUG}/out/Changed Since Approval - High Level Design.docx`, 'rendered hld', { branch: hldBranch })

      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      assert.equal(typeof opened.pullRequestId, 'number', JSON.stringify(opened))

      // Filling HLD's gate fills two Fields the SOAP's Full SOAP Artefact prints and left empty when SOAP
      // was approved (`dependencies` and `open-questions` are mounted at both), so SOAP is already flagged.
      const before = await post(`/api/instance/check-status?slug=${SLUG}`)
      assert.equal(before.merged, false)
      assert.deepEqual(before.changedSinceApproval.map((e) => [e.stageId, e.fields]), [
        ['shape', ['dependencies.dependencies-overview', 'open-questions.questions']],
      ])

      await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'Changed at HLD.'))
      const after = await post(`/api/instance/check-status?slug=${SLUG}`)
      assert.deepEqual(after.changedSinceApproval.map((e) => [e.stageId, e.count]), [['shape', 3]])
    })
  })
}

test('a local workspace never shows the flag', async () => {
  await withRunningExamplesServer({}, async (base) => {
    const instance = await (await fetch(`${base}/api/instance?slug=examples`)).json()
    assert.equal(instance.workspaceBacked, false)
    assert.deepEqual(instance.changedSinceApproval, [])
    const rows = await (await fetch(`${base}/api/instances`)).json()
    for (const row of rows) assert.equal(row.changedSinceApproval, undefined, `local row "${row.slug}" has no flag`)
  })
})
