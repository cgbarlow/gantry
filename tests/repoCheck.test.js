import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAzureDevOpsRepo, migrateLegacyAzureDevOpsInstance } from '../lib/repoCheck.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// checkAzureDevOpsRepo/migrateLegacyAzureDevOpsInstance (#100): moving
// Azure-DevOps-backed instance storage from repo root to a per-slug
// gantry-workspace/<slug>/ subdirectory, so one repo ("workspace") can
// host more than one instance, plus the one-time migration routine that
// brings a pre-#100 repo-root instance into that new layout.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function withFakeRepo(files, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, fn)
}

function locationFor(baseUrl) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
}

const CONTEXT_MODULE = [
  '---',
  'module: context',
  'status: draft',
  'owner: c.barlow',
  '---',
  '',
  '## Business driver',
  '',
  'Seeded from the fake Azure DevOps repo.',
  '',
  '## Affected domains',
  '',
  '- Payments',
  '',
  '## Explicitly out of scope',
  '',
  'Nothing yet.',
  '',
].join('\n')

test('checkAzureDevOpsRepo reports "empty" for a repo with no instance data anywhere', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
    assert.equal(result.result, 'empty')
  })
})

// Acceptance criterion (#100): "An existing repo with a single root-level
// instance is migrated ... either on adoption/first access or via an
// explicit migration routine."
test('checkAzureDevOpsRepo migrates a legacy repo-root instance to gantry-workspace/<slug>/ on first access, leaving nothing behind at root', async () => {
  await withFakeRepo(
    {
      '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/modules/context.md': CONTEXT_MODULE,
    },
    async (baseUrl) => {
      const result = await checkAzureDevOpsRepo({ ...locationFor(baseUrl) })
      assert.deepEqual(result, {
        result: 'found',
        slug: 'my-initiative',
        definition: 'design',
        stage: 'shape',
        status: 'incomplete',
        assignee: '',
      })

      const client = createAzureDevOpsClient(locationFor(baseUrl))

      // The new location has the migrated data.
      const migratedInstance = await client.getFileContent('gantry-workspace/my-initiative/instance.yaml')
      assert.match(migratedInstance, /slug: my-initiative/)
      const migratedModule = await client.getFileContent('gantry-workspace/my-initiative/modules/context.md')
      assert.equal(migratedModule, CONTEXT_MODULE)

      // No repo is left with instance data at both root and subdirectory
      // simultaneously (#100's acceptance criteria) — the legacy copies
      // are gone.
      await assert.rejects(() => client.getFileContent('instance.yaml'), AzureDevOpsNotFoundError)
      await assert.rejects(() => client.getFileContent('modules/context.md'), AzureDevOpsNotFoundError)
    }
  )
})

test('checkAzureDevOpsRepo discovers an already-migrated instance (no legacy root instance.yaml) directly under gantry-workspace/<slug>/', async () => {
  await withFakeRepo(
    {
      '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/gantry-workspace/my-initiative/modules/context.md': CONTEXT_MODULE,
    },
    async (baseUrl) => {
      const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
      assert.deepEqual(result, {
        result: 'found',
        slug: 'my-initiative',
        definition: 'design',
        stage: 'shape',
        status: 'incomplete',
        assignee: '',
      })
    }
  )
})

// Acceptance criterion (#100): "Tests cover ... migrating a pre-existing
// root-level instance" — re-checking an already-migrated repo a second
// time must not error or attempt to migrate again (nothing left at root).
test('checkAzureDevOpsRepo is safe to call again on an already-migrated repo', async () => {
  await withFakeRepo(
    {
      '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/modules/context.md': CONTEXT_MODULE,
    },
    async (baseUrl) => {
      const first = await checkAzureDevOpsRepo(locationFor(baseUrl))
      const second = await checkAzureDevOpsRepo(locationFor(baseUrl))
      assert.deepEqual(first, second)
    }
  )
})

test('checkAzureDevOpsRepo reports "multiple" when more than one instance already exists under gantry-workspace/, without guessing which one', async () => {
  await withFakeRepo(
    {
      '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
      '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
    },
    async (baseUrl) => {
      const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
      assert.equal(result.result, 'multiple')
      assert.deepEqual(result.slugs, ['alpha-initiative', 'beta-initiative'])
    }
  )
})

test('checkAzureDevOpsRepo reports "found" with an empty slug for a legacy instance.yaml with no slug set, without attempting to migrate it', async () => {
  await withFakeRepo({ '/instance.yaml': 'definition: design\nstage: shape\n' }, async (baseUrl) => {
    const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
    assert.equal(result.result, 'found')
    assert.equal(result.slug, '')

    // Nothing was migrated — there was no slug to build a destination
    // path from.
    const client = createAzureDevOpsClient(locationFor(baseUrl))
    await client.getFileContent('instance.yaml')
  })
})

test('checkAzureDevOpsRepo reports "found" with the raw malformed slug for a legacy instance.yaml with a path-like slug, without migrating it', async () => {
  await withFakeRepo({ '/instance.yaml': 'definition: design\nslug: ../evil\nstage: shape\n' }, async (baseUrl) => {
    const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
    assert.equal(result.result, 'found')
    assert.equal(result.slug, '../evil')

    // Never attempted to write to a gantry-workspace/../evil/ path built
    // from the untrusted slug — the legacy file is still exactly where it
    // was.
    const client = createAzureDevOpsClient(locationFor(baseUrl))
    await client.getFileContent('instance.yaml')
  })
})

// Regression test for a review finding: the legacy root instance.yaml —
// the only signal checkAzureDevOpsRepo uses to decide "this repo still
// needs migrating" — must stay in place until every module has actually
// been migrated, not be deleted right after the new instance.yaml is
// written. Otherwise a transient failure partway through the modules loop
// (a network blip, an expired PAT — exactly what failAfterPushes
// simulates here) would leave the repo looking "fully migrated" to any
// later check, permanently stranding whichever module(s) hadn't been
// reached yet: silently reported thereafter as having "no saved data"
// instead of the real, previously-saved content they still hold at their
// now-orphaned legacy path.
test('an interrupted migration leaves the legacy root instance.yaml in place (not deleted) so it can still be detected and retried', async () => {
  const files = {
    '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
    '/modules/context.md': CONTEXT_MODULE,
    '/modules/solution-definition.md':
      '---\nmodule: solution-definition\nstatus: complete\nowner: real.owner\n---\n\n## Solution\n\nReal, already-saved content.\n',
  }

  // Push 1: write the new instance.yaml. Push 2: write "context" (the
  // first module, per listFolder's alphabetical order) to its new
  // location. Failing after 2 pushes interrupts the very next step —
  // deleting "context"'s legacy copy — before "solution-definition" (the
  // second module) is ever touched.
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files, failAfterPushes: 2 },
    async (baseUrl) => {
      await assert.rejects(() => checkAzureDevOpsRepo(locationFor(baseUrl)))

      const client = createAzureDevOpsClient(locationFor(baseUrl))

      // The detection signal a retry depends on is still there.
      await client.getFileContent('instance.yaml')
      // The not-yet-reached module's real, previously-saved content is
      // still intact at its legacy path — not stranded invisibly, since
      // nothing has (yet) told the app the migration is complete.
      const stillLegacySolutionDefinition = await client.getFileContent('modules/solution-definition.md')
      assert.match(stillLegacySolutionDefinition, /Real, already-saved content\./)
    }
  )
})

// The companion to the test above: given a repo left in exactly the state
// an interrupted migration produces (legacy root instance.yaml still
// present, one module already migrated, one module still only at its
// legacy path), a fresh checkAzureDevOpsRepo call must finish the job —
// migrating the remaining module and only then removing the legacy
// instance.yaml — without corrupting or losing the module that had
// already been migrated.
test('checkAzureDevOpsRepo resumes and completes a previously-interrupted migration, without stranding or corrupting either module', async () => {
  await withFakeRepo(
    {
      '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/gantry-workspace/my-initiative/modules/context.md': CONTEXT_MODULE,
      '/modules/solution-definition.md':
        '---\nmodule: solution-definition\nstatus: complete\nowner: real.owner\n---\n\n## Solution\n\nReal, already-saved content.\n',
    },
    async (baseUrl) => {
      const result = await checkAzureDevOpsRepo(locationFor(baseUrl))
      assert.equal(result.result, 'found')
      // Neither seed instance.yaml sets an assignee — the instance record's
      // own stored field (#97), no longer derived from module frontmatter —
      // so it defaults to ''. "team-and-estimates" (the third module) was
      // never seeded here, so status stays "incomplete"; that rollup isn't
      // what this test is about.
      assert.equal(result.assignee, '')

      const client = createAzureDevOpsClient(locationFor(baseUrl))

      // The already-migrated module is untouched/uncorrupted...
      assert.equal(await client.getFileContent('gantry-workspace/my-initiative/modules/context.md'), CONTEXT_MODULE)
      // ...and the previously-stranded one is now migrated too, with its
      // real content intact.
      const migratedSolutionDefinition = await client.getFileContent('gantry-workspace/my-initiative/modules/solution-definition.md')
      assert.match(migratedSolutionDefinition, /Real, already-saved content\./)

      // Nothing left behind at either legacy path.
      await assert.rejects(() => client.getFileContent('instance.yaml'), AzureDevOpsNotFoundError)
      await assert.rejects(() => client.getFileContent('modules/solution-definition.md'), AzureDevOpsNotFoundError)
    }
  )
})

test('migrateLegacyAzureDevOpsInstance moves instance.yaml and every module file, and is safe to re-run', async () => {
  await withFakeRepo(
    {
      '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/modules/context.md': CONTEXT_MODULE,
      '/modules/solution-definition.md': '# Solution\n',
    },
    async (baseUrl) => {
      const client = createAzureDevOpsClient(locationFor(baseUrl))
      const instanceYamlText = await client.getFileContent('instance.yaml')

      await migrateLegacyAzureDevOpsInstance(client, 'my-initiative', instanceYamlText)

      assert.equal(await client.getFileContent('gantry-workspace/my-initiative/instance.yaml'), instanceYamlText)
      assert.equal(await client.getFileContent('gantry-workspace/my-initiative/modules/context.md'), CONTEXT_MODULE)
      assert.equal(await client.getFileContent('gantry-workspace/my-initiative/modules/solution-definition.md'), '# Solution\n')
      await assert.rejects(() => client.getFileContent('instance.yaml'), AzureDevOpsNotFoundError)
      await assert.rejects(() => client.getFileContent('modules/context.md'), AzureDevOpsNotFoundError)
      await assert.rejects(() => client.getFileContent('modules/solution-definition.md'), AzureDevOpsNotFoundError)

      // Re-running against the same (now legacy-empty) content is a safe
      // no-op re-write of the already-migrated files — used as the
      // "explicit migration routine" entry point on its own, independent
      // of checkAzureDevOpsRepo's own lazy call.
      await migrateLegacyAzureDevOpsInstance(client, 'my-initiative', instanceYamlText)
      assert.equal(await client.getFileContent('gantry-workspace/my-initiative/instance.yaml'), instanceYamlText)
    }
  )
})
