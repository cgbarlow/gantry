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

// #276, ADR-0069 — re-rendering is required before re-approval, and the earlier approved documents are
// kept. Real HTTP against a real gantry server and a real in-process fake of each provider, for GitHub and
// Azure DevOps.
//
// The scenario: SOAP (`shape`) is approved and merged, so the Instance moves on to HLD (`hld-define`).
// `background` is mounted at both. SOAP prints `background.problem` (its `requires` lists name it);
// only HLD prints `background.success-criteria`. So editing the first from HLD changes approved SOAP
// content, and editing the second does not.

const SLUG = 'rerender-earlier'
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
        await client.writeFile(`gantry-workspace/${SLUG}/out/Rerender Earlier - Solution on a Page.docx`, 'rendered soap', { branch: shapeBranch })

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


const SOAP_DOCX = (name) => `gantry-workspace/${SLUG}/out/${name}.docx`
const SOAP_NAME = 'Rerender Earlier - Solution on a Page'
const APPROVED_DIR = `gantry-workspace/${SLUG}/out/approved`

// Fills HLD's gate so it can ask for approval, as the "Check status" test of #273 does.
async function readyHld({ ctx, provider, client, writeOnHld }) {
  for (const moduleId of HLD.modules) {
    if (SHAPE_MODULES.includes(moduleId)) continue
    await writeOnHld(moduleId, exampleModuleText(moduleId))
  }
  const hldBranch = await provider.resolveBranch(ctx, 'hld-define')
  await client.writeFile(`gantry-workspace/${SLUG}/out/Rerender Earlier - High Level Design.docx`, 'rendered hld', { branch: hldBranch })
  return hldBranch
}

for (const providerId of Object.keys(PROVIDERS)) {
  const { name } = PROVIDERS[providerId]

  test(`${name}: Request approval is refused until SOAP's document is re-rendered, then the approved copy is kept and the new one takes the usual name`, async () => {
    await withApprovedSoap(providerId, async (env) => {
      const { ctx, client, post, soapTexts, writeOnHld, headers } = env
      const hldBranch = await readyHld(env)
      await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'Reworded during HLD review.'))

      // Refused, naming what to re-render. The Full SOAP was never rendered when SOAP was approved (it did not
      // pass the gate), so there is no approved document of it to replace and it is not asked for.
      const refusedRes = await fetch(`${ctx.gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers })
      const refused = await refusedRes.json()
      assert.equal(refusedRes.status, 400)
      assert.match(refused.error, /re-rendered/)
      assert.match(refused.error, /Solution on a Page/)
      assert.deepEqual(
        refused.reRenderRequired.map((item) => [item.stageId, item.artefactId, item.fields]),
        [['shape', 'soap', ['background.problem']]]
      )

      // Offered from the refusal: render it onto HLD's branch.
      const rendered = await post(`/api/instance/rerender-earlier/soap?slug=${SLUG}`)
      assert.equal(rendered.artefact, 'soap', JSON.stringify(rendered))
      assert.equal(rendered.stage, 'shape')
      assert.equal(rendered.branch, hldBranch)
      assert.equal(rendered.path, SOAP_DOCX(SOAP_NAME))
      assert.match(rendered.approvedCopyPath, new RegExp(`^${APPROVED_DIR}/${SOAP_NAME} — approved \\d{4}-\\d{2}-\\d{2}\\.docx$`))

      // The approved copy is exactly the document SOAP was approved with, kept beside the others...
      assert.equal((await client.getFileBytes(rendered.approvedCopyPath, { branch: hldBranch })).toString(), 'rendered soap')
      // ...and the usual name is now the new render, a real Word file.
      const current = await client.getFileBytes(SOAP_DOCX(SOAP_NAME), { branch: hldBranch })
      assert.equal(current.subarray(0, 2).toString(), 'PK')
      // main still holds the approved version.
      assert.equal((await client.getFileBytes(SOAP_DOCX(SOAP_NAME), { branch: 'main' })).toString(), 'rendered soap')

      // Nothing left to re-render, so the Pull Request opens.
      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      assert.equal(typeof opened.pullRequestId, 'number', JSON.stringify(opened))
    })
  })

  test(`${name}: a Field changed after the re-render makes it stale again, and a second re-render keeps the one approved copy`, async () => {
    await withApprovedSoap(providerId, async (env) => {
      const { ctx, client, post, soapTexts, writeOnHld, headers } = env
      const hldBranch = await readyHld(env)
      await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'First rewording.'))
      const first = await post(`/api/instance/rerender-earlier/soap?slug=${SLUG}`)
      const firstDoc = await client.getFileBytes(SOAP_DOCX(SOAP_NAME), { branch: hldBranch })

      await writeOnHld('background', withFieldText(soapTexts.background, 'Problem statement', 'Second rewording.'))
      const refused = await fetch(`${ctx.gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers })
      assert.equal(refused.status, 400)
      assert.deepEqual((await refused.json()).reRenderRequired.map((item) => item.artefactId), ['soap'])

      const second = await post(`/api/instance/rerender-earlier/soap?slug=${SLUG}`)
      assert.equal(second.approvedCopyPath, first.approvedCopyPath)
      // The approved copy is still the approved document, not the first re-render.
      assert.equal((await client.getFileBytes(second.approvedCopyPath, { branch: hldBranch })).toString(), 'rendered soap')
      const files = (await client.listFolder(APPROVED_DIR, { branch: hldBranch })).filter((item) => !item.isFolder).map((item) => item.path.split('/').pop())
      assert.deepEqual(files.filter((file) => file.endsWith('.docx')), [first.approvedCopyPath.split('/').pop()])
      assert.notDeepEqual(await client.getFileBytes(SOAP_DOCX(SOAP_NAME), { branch: hldBranch }), firstDoc)

      assert.equal(typeof (await post(`/api/instance/request-approval?slug=${SLUG}`)).pullRequestId, 'number')
    })
  })

  test(`${name}: nothing is asked for when no Field an earlier stage prints has changed`, async () => {
    await withApprovedSoap(providerId, async (env) => {
      const { ctx, post, soapTexts, writeOnHld, headers } = env
      // Only the HLD prints `success-criteria`, so this edit changes nothing SOAP prints. (Filling the HLD's own
      // gate does fill two Fields the Full SOAP prints, so SOAP is flagged by that, but the Full SOAP was never
      // rendered when SOAP was approved and so has no approved document to replace.)
      await readyHld(env)
      await writeOnHld('background', withFieldText(soapTexts.background, 'Success criteria', 'Only the HLD prints this.'))
      const opened = await post(`/api/instance/request-approval?slug=${SLUG}`)
      assert.equal(typeof opened.pullRequestId, 'number', JSON.stringify(opened))

      // And there is nothing to render onto the stage either.
      const refusal = await fetch(`${ctx.gantryBase}/api/instance/rerender-earlier/soap?slug=${SLUG}`, { method: 'POST', headers })
      assert.equal(refusal.status, 400)
      assert.match((await refusal.json()).error, /does not need re-rendering/)
    })
  })

  test(`${name}: an unknown Artefact cannot be re-rendered`, async () => {
    await withApprovedSoap(providerId, async ({ ctx, headers }) => {
      const unknown = await fetch(`${ctx.gantryBase}/api/instance/rerender-earlier/no-such-artefact?slug=${SLUG}`, { method: 'POST', headers })
      assert.equal(unknown.status, 400)
      assert.match((await unknown.json()).error, /no artefact/)
    })
  })
}

test('a local workspace has nothing to re-render', async () => {
  await withRunningExamplesServer({}, async (base) => {
    const res = await fetch(`${base}/api/instance/rerender-earlier/soap?slug=examples`, { method: 'POST' })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /GitHub, Azure DevOps and GitLab/)
  })
})
