import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, readInstance } from '../lib/instance.js'
import { registerInstance, scopeIdForDirectoryFolder, listRegisteredInstances } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import {
  withRunningServer,
  withRunningServerForProvider,
  withScratchInstances,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
  GITLAB_NAMESPACE,
  GITLAB_REPOSITORY,
  GITLAB_VALID_PAT,
} from './helpers/lifecycle.js'

// #124 regression coverage: GET/PUT /api/instance/synced-fields used to resolve an instance's
// provider by testing ONLY for Azure DevOps (`resolveAzureDevOpsLocation`) and, when that returned
// null, falling straight through to the LOCAL-instance branch — silently reading/writing a local
// directory for a GitHub- or GitLab-backed design instead of erroring or reaching the real repo.
// These tests would FAIL if either route (or `lib/syncedFields.js`'s own read/write dispatch)
// reverted to that two-way "Azure DevOps or local" assumption.

function seedFiles(slug) {
  return { [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n` }
}

function withScratchProviderServer(provider, fn, { fakeServerOptions } = {}) {
  return withScratchInstances((instancesDir) =>
    withRunningServerForProvider(provider, { options: { instancesDir }, fakeServerOptions }, (ctx) => fn({ ...ctx, instancesDir }))
  )
}

function registerGitHubInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
}

function registerGitLabInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
}

test('GET/PUT /api/instance/synced-fields on a GitHub-backed design read and persist against the GitHub repo, not local disk', async () => {
  const slug = 'github-synced-fields'
  await withScratchProviderServer(
    'github',
    async (ctx) => {
      registerGitHubInstance(slug, ctx)

      // No PAT at all: a Workspace-backed design's synced-fields panel always needs a credential
      // (unlike a local instance, which only needs one once linked) — the structured
      // "authentication required" response, naming the right provider.
      const noPatRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`)
      assert.equal(noPatRes.status, 401)
      const noPatBody = await noPatRes.json()
      assert.equal(noPatBody.error, 'authentication_required')
      assert.match(noPatBody.message, /GitHub/)

      const getRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(getRes.status, 200)
      const body = await getRes.json()
      assert.equal(body.linked, false)
      assert.equal(body.title, `${slug} — SOAP`)
      assert.equal(body.titleOverridden, false)

      const putRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Shaped on GitHub', assignee: 'Ada Lovelace' }),
      })
      assert.equal(putRes.status, 200)
      const saved = await putRes.json()
      assert.equal(saved.title, 'Shaped on GitHub')
      assert.equal(saved.titleOverridden, true)
      assert.equal(saved.assignee, 'Ada Lovelace')
      assert.equal(saved.assigneeInherited, false)

      // Genuinely persisted in the GitHub repo (on the "shape" stage's own branch, #122's write
      // convention) — read it straight back via the GitHub-backed half of readInstance, never through
      // a local instancesDir.
      const stored = await readInstance(slug, {
        github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl, pat: GITHUB_VALID_PAT, branch: stageBranchName(slug, 'shape') },
      })
      assert.deepEqual(stored.syncedFields.shape, { title: 'Shaped on GitHub', assignee: 'Ada Lovelace' })

      // Re-reading through the panel reflects the same persisted override.
      const reread = await (
        await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
      ).json()
      assert.equal(reread.title, 'Shaped on GitHub')
      assert.equal(reread.assignee, 'Ada Lovelace')
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('GET/PUT /api/instance/synced-fields on a GitLab-backed design read and persist against the GitLab repo, not local disk', async () => {
  const slug = 'gitlab-synced-fields'
  await withScratchProviderServer(
    'gitlab',
    async (ctx) => {
      registerGitLabInstance(slug, ctx)

      const noPatRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`)
      assert.equal(noPatRes.status, 401)
      assert.match((await noPatRes.json()).message, /GitLab/)

      const getRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      })
      assert.equal(getRes.status, 200)
      const body = await getRes.json()
      assert.equal(body.linked, false)
      assert.equal(body.titleOverridden, false)

      const putRes = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Shaped on GitLab', assignee: 'Grace Hopper' }),
      })
      assert.equal(putRes.status, 200)
      const saved = await putRes.json()
      assert.equal(saved.title, 'Shaped on GitLab')
      assert.equal(saved.assignee, 'Grace Hopper')
      assert.equal(saved.assigneeInherited, false)

      const stored = await readInstance(slug, {
        gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: ctx.providerBaseUrl, pat: GITLAB_VALID_PAT, branch: stageBranchName(slug, 'shape') },
      })
      assert.deepEqual(stored.syncedFields.shape, { title: 'Shaped on GitLab', assignee: 'Grace Hopper' })
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('a local design sharing its slug with a GitHub-backed one is never read (or written) by mistake', async () => {
  const slug = 'shared-slug-design'
  await withScratchProviderServer(
    'github',
    async (ctx) => {
      const { instancesDir } = ctx
      registerGitHubInstance(slug, ctx)
      const githubScopeId = listRegisteredInstances({ instancesDir }).find((row) => row.slug === slug && row.location.kind === 'github').scopeId

      // A genuinely local instance, same slug, distinguishable by its own assignee — created directly
      // under the reserved `default` server-workspace folder (rather than relying on
      // `withRunningServer`'s startup-migration timing, which has already run by this point) so it's
      // discovered under `default`'s own scope (`scopeIdForDirectoryFolder('default')`) on the very
      // next registry read, exactly like a real `default`-workspace instance.
      createInstance('design', slug, { instancesDir: join(instancesDir, 'default'), assignee: 'Local Person' })
      const localScopeId = scopeIdForDirectoryFolder('default')

      // Addressing the GitHub-backed one explicitly (via its own scope) reads/writes GitHub content —
      // never the local design that happens to share its slug.
      const githubGet = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}&scope=${githubScopeId}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(githubGet.status, 200)
      const githubBody = await githubGet.json()
      // The GitHub-backed design has no `assignee` of its own yet — inherited default is blank, not
      // "Local Person" (proof this never fell through to the local read).
      assert.equal(githubBody.assignee, '')
      assert.equal(githubBody.assigneeInherited, true)

      const githubPut = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}&scope=${githubScopeId}`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee: 'GitHub Person' }),
      })
      assert.equal(githubPut.status, 200)
      assert.equal((await githubPut.json()).assignee, 'GitHub Person')

      // The local design, addressed via its own scope, is completely untouched.
      const localGet = await fetch(`${ctx.gantryBase}/api/instance/synced-fields?slug=${slug}&scope=${localScopeId}`)
      assert.equal(localGet.status, 200)
      const localBody = await localGet.json()
      assert.equal(localBody.assignee, 'Local Person')
      assert.equal(localBody.assigneeInherited, true)

      // And the local instance.yaml on disk was never written to by the GitHub PUT above.
      const localStored = readInstance(slug, { instancesDir: join(instancesDir, 'default') })
      assert.equal(localStored.assignee, 'Local Person')
      assert.equal(localStored.syncedFields, undefined)
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('GET/PUT /api/instance/synced-fields fail with a clear error for a registry entry this server cannot resolve, rather than silently reading local', async () => {
  await withScratchInstances(async (instancesDir) => {
    const slug = 'orphaned-provider-design'
    // A registry entry of a kind no INSTANCE_PROVIDER_LOCATION_RESOLVERS resolver (or the local
    // 'directory' kind) recognizes — the "genuinely orphaned/malformed registry entry" acceptance
    // criterion. Bypasses registerInstance's own validation (which would reject this kind outright)
    // to simulate a hand-edited/legacy registry file — same on-disk shape/filename
    // tests/instanceRegistry.test.js's own raw-registry-file assertions already use.
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(registryPath, JSON.stringify({ 'some-scope': { [slug]: { kind: 'atlassian' } } }))

    await withRunningServer({ instancesDir }, async (base) => {
      const getRes = await fetch(`${base}/api/instance/synced-fields?slug=${slug}&scope=some-scope`)
      assert.equal(getRes.status, 400)
      const getBody = await getRes.json()
      assert.match(getBody.error, /doesn't know how to resolve/)
      assert.match(getBody.error, /"atlassian"/)

      const putRes = await fetch(`${base}/api/instance/synced-fields?slug=${slug}&scope=some-scope`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Should never be saved anywhere' }),
      })
      assert.equal(putRes.status, 400)
      assert.match((await putRes.json()).error, /doesn't know how to resolve/)
    })
  })
})
