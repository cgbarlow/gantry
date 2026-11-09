import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createInstance, recordInstancePullRequest } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { renderArtefact } from '../lib/render.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveGitHubStageBranch, stageBranchName as githubStageBranchName } from '../lib/githubStageBranch.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { parseDecisionsLog } from '../web/lib/decisionsLog.js'
import { designV3Examples, V3_REFERENCES } from './helpers/designExamples.js'
import {
  withRunningServer,
  withRunningServerForProvider,
  basicAuthHeader,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #362: "Move to v<N>" through GET and POST /api/instance/definition-move, on a server workspace on the server's disk and on GitHub and
// Azure DevOps workspaces, with the same stand-ins as tests/instanceSettings.test.js: a scratch copy of the design examples as they
// were on design v3 (tests/helpers/designExamples.js), the real design v1–v4, and the fake Providers. What changes between two
// versions is tests/definitionVersionMove.test.js's; this is the move itself: one change, nothing written when it fails, recorded in
// the current Stage's decisions log, and blocked while the Stage awaits approval. A Local workspace's move is in the browser
// (tests/definitionVersionMove.playwright.test.js).

const SLUG = 'kiwi-cover-mutual'
const MODULE = 'modules/team-and-estimates.md'
const V4_EXAMPLE = join('workspaces', 'examples', SLUG)
const json = { 'Content-Type': 'application/json' }
const post = (body, headers = {}) => ({ method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) })

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))
}
const snapshot = (dir) => Object.fromEntries(filesUnder(dir).map((path) => [relative(dir, path), readFileSync(path, 'utf8')]))

// A server workspace on disk holding the v3 Kiwi Cover Mutual example (References and all), as a flat data directory.
async function withV3Example(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-362-'))
  try {
    cpSync(join(designV3Examples(), SLUG), join(instancesDir, SLUG), { recursive: true })
    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, (base) => fn({ base, instancesDir, dir: join(instancesDir, SLUG) }))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a server workspace\'s design v3 Instance with References offers v4, and the move leaves every file but three byte for byte as it was', () =>
  withV3Example(async ({ base, instancesDir, dir }) => {
    const offer = await (await fetch(`${base}/api/instance/definition-move?slug=${SLUG}`)).json()
    assert.equal(offer.available, true)
    assert.deepEqual([offer.definition, offer.from, offer.to], ['design', 3, 4])
    assert.deepEqual(offer.removed, [{ moduleId: 'team-and-estimates', moduleTitle: 'Teams, contact persons, and high-level estimates', fieldId: 'references', fieldTitle: 'References' }])
    assert.deepEqual([offer.added, offer.newlyRequired, offer.typeChanged], [[], [], []])
    assert.match(offer.changelog, /^## v4\n/)
    assert.equal(offer.blocked, null)

    const before = snapshot(dir)
    const res = await fetch(`${base}/api/instance/definition-move?slug=${SLUG}`, post({ to: 4 }))
    assert.equal(res.status, 200, await res.clone().text())
    const moved = await res.json()
    assert.equal(moved.definitionVersion, 4)
    assert.deepEqual(moved.removed.map((f) => f.fieldId), ['references'])

    // The Module file and instance.yaml are the bundled v4 example's, byte for byte.
    assert.equal(readFileSync(join(dir, MODULE), 'utf8'), readFileSync(join(V4_EXAMPLE, MODULE), 'utf8'))
    assert.equal(readFileSync(join(dir, 'instance.yaml'), 'utf8'), readFileSync(join(V4_EXAMPLE, 'instance.yaml'), 'utf8'))
    // The decisions log of the current Stage keeps every entry it had and gains the move.
    const log = parseDecisionsLog(readFileSync(join(dir, 'interview/shape.yaml'), 'utf8'), 'shape')
    const was = parseDecisionsLog(before['interview/shape.yaml'], 'shape')
    assert.deepEqual(log.entries.slice(0, was.entries.length), was.entries)
    const entry = log.entries.at(-1)
    assert.equal(entry.kind, 'definition-move')
    assert.equal(entry.note, 'Moved from v3 to v4. Removed: References (Teams, contact persons, and high-level estimates).')
    assert.deepEqual(entry.removed, [{ module: 'team-and-estimates', field: 'references', title: 'References', moduleTitle: 'Teams, contact persons, and high-level estimates' }])
    // Everything else is untouched.
    const after = snapshot(dir)
    for (const path of Object.keys(before)) {
      if ([MODULE, 'instance.yaml', 'interview/shape.yaml'].includes(path)) continue
      assert.equal(after[path], before[path], path)
    }
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'no file added or removed')

    // The SAD renders on v4, without References.
    const sad = renderArtefact(SLUG, 'sad', { instancesDir, dryRun: true }).markdown
    assert.match(sad, /design v4 · /)
    assert.ok(!sad.split('\n').some((line) => /^#+ References$/.test(line)), 'no References heading')
    assert.ok(!sad.includes(V3_REFERENCES[SLUG].split('\n')[2].slice(2)), 'none of its items')

    // Now on the latest published version: nothing is offered, and a second move is refused.
    assert.deepEqual(await (await fetch(`${base}/api/instance/definition-move?slug=${SLUG}`)).json(), { available: false, definitionVersion: 4 })
    const again = await fetch(`${base}/api/instance/definition-move?slug=${SLUG}`, post({ to: 4 }))
    assert.equal(again.status, 409)
    assert.match((await again.json()).error, /already on the latest published version/)
  }))

test('only the latest published version is offered: a v4 Instance shows no move and a v2 Instance is offered v4, not v3', () =>
  withV3Example(async ({ base, instancesDir }) => {
    createInstance('design', 'on-v4', { instancesDir })
    createInstance('design', 'on-v2', { instancesDir, definitionVersion: 2 })
    assert.equal((await (await fetch(`${base}/api/instance/definition-move?slug=on-v4`)).json()).available, false)
    const offer = await (await fetch(`${base}/api/instance/definition-move?slug=on-v2`)).json()
    assert.deepEqual([offer.from, offer.to], [2, 4])
    // A fresh v2 Instance has every Module's sections, but none of them with content: nothing to name.
    assert.deepEqual(offer.removed, [])

    const stale = await fetch(`${base}/api/instance/definition-move?slug=on-v2`, post({ to: 3 }))
    assert.equal(stale.status, 409)
    assert.match((await stale.json()).error, /v4 is now the latest published version of design, not v3\. Nothing was changed/)
    assert.equal(parseYAML(readFileSync(join(instancesDir, 'on-v2', 'instance.yaml'), 'utf8')).definitionVersion, 2)
    const bad = await fetch(`${base}/api/instance/definition-move?slug=on-v2`, post({ to: 'latest' }))
    assert.equal(bad.status, 400)
  }))

// Root can write a read-only file, so this needs an ordinary user (as Gantry and its tests run).
test('a move whose write fails part-way leaves the Instance as it was, and says so', { skip: process.getuid?.() === 0 }, () =>
  withV3Example(async ({ base, dir }) => {
    const before = snapshot(dir)
    chmodSync(join(dir, 'instance.yaml'), 0o444)
    try {
      const res = await fetch(`${base}/api/instance/definition-move?slug=${SLUG}`, post({ to: 4 }))
      assert.equal(res.status, 500)
      assert.match((await res.json()).error, /^Nothing was changed: the move to v4 could not be written/)
    } finally {
      chmodSync(join(dir, 'instance.yaml'), 0o644)
    }
    assert.deepEqual(snapshot(dir), before, 'the Module file and the decisions log were put back')
  }))

// ---------- Provider workspaces ----------

const v3Files = () => {
  const source = join(designV3Examples(), SLUG)
  return {
    [`/gantry-workspace/${SLUG}/instance.yaml`]: readFileSync(join(source, 'instance.yaml'), 'utf8'),
    [`/gantry-workspace/${SLUG}/${MODULE}`]: readFileSync(join(source, MODULE), 'utf8'),
    [`/gantry-workspace/${SLUG}/modules/background.md`]: readFileSync(join(source, 'modules/background.md'), 'utf8'),
    [`/gantry-workspace/${SLUG}/interview/shape.yaml`]: readFileSync(join(source, 'interview/shape.yaml'), 'utf8'),
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

async function withProvider(spec, fakeServerOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-362-provider-'))
  try {
    await withRunningServerForProvider(spec.provider, { options: { instancesDir }, fakeServerOptions: { files: v3Files(), ...fakeServerOptions } }, async (ctx) => {
      spec.register(instancesDir, ctx.providerBaseUrl)
      const location = spec.location(ctx.providerBaseUrl)
      const call = (method, body) => fetch(`${ctx.gantryBase}/api/instance/definition-move?slug=${SLUG}`, { method, headers: { ...spec.auth, ...json }, body: body === undefined ? undefined : JSON.stringify(body) })
      await fn({ ...ctx, location, client: spec.client(location), call })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: the move is one commit on the current Stage's branch, with the Module file, the decisions log and the version, and main is untouched`, () =>
    withProvider(spec, {}, async ({ client, call }) => {
      const offer = await (await call('GET')).json()
      assert.deepEqual([offer.from, offer.to, offer.removed.map((f) => f.fieldId), offer.blocked], [3, 4, ['references'], null])
      const branch = spec.branchName(SLUG, 'shape')
      assert.equal(await client.branchExists(branch), false, 'a read starts no branch')

      const res = await call('POST', { to: 4 })
      assert.equal(res.status, 200, await res.clone().text())
      const at = (path) => client.getFileContent(`gantry-workspace/${SLUG}/${path}`, { branch })
      assert.equal(await at(MODULE), readFileSync(join(V4_EXAMPLE, MODULE), 'utf8'))
      assert.equal(await at('instance.yaml'), readFileSync(join(V4_EXAMPLE, 'instance.yaml'), 'utf8'))
      assert.equal(await at('modules/background.md'), v3Files()[`/gantry-workspace/${SLUG}/modules/background.md`])
      const log = parseDecisionsLog(await at('interview/shape.yaml'), 'shape')
      assert.equal(log.entries.at(-1).note, 'Moved from v3 to v4. Removed: References (Teams, contact persons, and high-level estimates).')
      assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/${MODULE}`), v3Files()[`/gantry-workspace/${SLUG}/${MODULE}`], 'main is untouched until the Stage is approved')

      if (spec.key === 'azureDevOps') {
        const commits = await client.listBranchCommits(branch, { compareTo: 'main' })
        assert.equal(commits.length, 1, 'one commit')
        assert.equal(commits[0].comment, `Instance "${SLUG}": Moved from v3 to v4. Removed: References (Teams, contact persons, and high-level estimates).`)
      }
      assert.equal((await (await call('GET')).json()).available, false, 'read back from the Stage\'s branch, the Instance is on v4')
    }))

  test(`${spec.name}: a Stage awaiting approval blocks the move with a sentence saying why, and nothing is written`, () =>
    withProvider(spec, {}, async ({ client, call, location }) => {
      const definition = loadDefinition('design', { version: 3 })
      const branch = await spec.resolve(location, definition, SLUG, 'shape')
      await recordInstancePullRequest(SLUG, 'shape', 41, { [spec.key]: { ...location, branch }, pullRequestStatus: 'active' })
      const before = await client.getFileContent(`gantry-workspace/${SLUG}/${MODULE}`, { branch })

      const offer = await (await call('GET')).json()
      assert.equal(offer.available, true)
      // The design Definition's first Stage, `shape`, is titled SOAP.
      const sentence = 'SOAP is awaiting approval, so this Instance can\'t move to v4 yet: the move would change content its Pull Request asks the Owner to approve. Move it once the Pull Request is approved or closed.'
      assert.equal(offer.blocked, sentence)
      const res = await call('POST', { to: 4 })
      assert.equal(res.status, 409)
      assert.deepEqual(await res.json(), { error: sentence, code: 'awaiting_approval' })
      assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/${MODULE}`, { branch }), before)
      assert.equal(parseYAML(await client.getFileContent(`gantry-workspace/${SLUG}/instance.yaml`, { branch })).definitionVersion, 3)
    }))
}

test('Azure DevOps: a push that fails changes nothing, and the dialog is told why', () =>
  withProvider(PROVIDERS[1], { failAfterPushes: 0 }, async ({ client, call }) => {
    const res = await call('POST', { to: 4 })
    assert.equal(res.status, 500)
    assert.match((await res.json()).error, /^Nothing was changed: the move to v4 could not be written/)
    const branch = stageBranchName(SLUG, 'shape')
    for (const ref of ['main', ...((await client.branchExists(branch)) ? [branch] : [])]) {
      assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/${MODULE}`, { branch: ref }), v3Files()[`/gantry-workspace/${SLUG}/${MODULE}`], ref)
      assert.equal(parseYAML(await client.getFileContent(`gantry-workspace/${SLUG}/instance.yaml`, { branch: ref })).definitionVersion, 3, ref)
    }
  }))
