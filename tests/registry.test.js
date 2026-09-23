import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, writeModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { listRegistry } from '../lib/registry.js'
import { registerInstance, archiveInstance } from '../lib/instanceRegistry.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withScratchInstances } from './helpers/lifecycle.js'

// WI #356: a directory-backed instance now lives inside a real server workspace folder (a
// workspace.json marker plus instance subdirectories), not directly under the workspaces root —
// this seeds one and returns its concrete path, so `createInstance`'s own (unchanged) local path can
// be pointed at it exactly like any other flat instancesDir.
function seedWorkspace(instancesDir, folder = 'default') {
  writeWorkspaceJson(instancesDir, folder, { name: folder, kind: 'local', createdAt: new Date().toISOString() })
  return join(instancesDir, folder)
}


test('listRegistry lists every instance, sorted by slug, with definition, current stage, status and assignee', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'zebra-initiative', { instancesDir: workspaceDir })
    createInstance('design', 'alpha-initiative', { instancesDir: workspaceDir, assignee: 'c.barlow' })

    const registry = listRegistry({ instancesDir })
    assert.deepEqual(
      registry.map(({ slug, definition, stage, status, assignee, name, workspaceNumber, instanceNumber, ref }) => ({
        slug,
        definition,
        stage,
        status,
        assignee,
        name,
        workspaceNumber,
        instanceNumber,
        ref,
      })),
      [
        {
          slug: 'alpha-initiative',
          definition: 'design',
          stage: 'shape',
          status: 'incomplete',
          assignee: 'c.barlow',
          name: null,
          workspaceNumber: 0,
          instanceNumber: 1,
          ref: 'w0i1',
        },
        {
          slug: 'zebra-initiative',
          definition: 'design',
          stage: 'shape',
          status: 'incomplete',
          assignee: '',
          name: null,
          workspaceNumber: 0,
          instanceNumber: 2,
          ref: 'w0i2',
        },
      ]
    )
    for (const row of registry) {
      assert.deepEqual(
        { stageNumber: row.stageNumber, stageCount: row.stageCount, stageTitle: row.stageTitle, pullRequestId: row.pullRequestId },
        { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null }
      )
      assert.doesNotThrow(() => new Date(row.updatedAt).toISOString())
    }
  })
})

test('listRegistry uses the newest local instance or module mtime for updatedAt', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'my-initiative', { instancesDir: workspaceDir })
    // Let any one-time module heading migration finish before making the timestamps deterministic for this assertion.
    listRegistry({ instancesDir })
    const instancePath = join(workspaceDir, 'my-initiative', 'instance.yaml')
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    const definition = loadDefinition('design')
    utimesSync(instancePath, older, older)
    for (const moduleId of definition.stages[0].modules) {
      utimesSync(join(workspaceDir, 'my-initiative', 'modules', `${moduleId}.md`), older, older)
    }
    utimesSync(join(workspaceDir, 'my-initiative', 'modules', 'background.md'), newer, newer)

    assert.equal(listRegistry({ instancesDir })[0].updatedAt, newer.toISOString())
  })
})

test('listRegistry reports "complete" once every required field for the current stage is filled in, independently of assignee', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'my-initiative', { instancesDir: workspaceDir, assignee: 'c.barlow' })
    const definition = loadDefinition('design')

    for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
      const moduleSpec = definition.modules.get(moduleId)
      const fields = {}
      for (const field of moduleSpec.fields) {
        if (field.required || field.requiredAt) fields[field.id] = field.type === 'list' ? ['Filled in.'] : 'Filled in.'
      }
      writeModule(definition, 'my-initiative', moduleId, { status: 'agreed', owner: '', fields }, { instancesDir: workspaceDir })
    }

    const registry = listRegistry({ instancesDir })
    const myInitiative = registry.find((i) => i.slug === 'my-initiative')
    assert.equal(myInitiative.status, 'complete')
    assert.equal(myInitiative.assignee, 'c.barlow')
  })
})

// The instance-level assignee (#97) is a plain field on the instance record, not derived by scanning any module's frontmatter `owner` — even though every module below has one set, it must not leak into this row.
test('listRegistry falls back to \'\' for assignee when the instance record has none set, regardless of module frontmatter owner', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'my-initiative', { instancesDir: workspaceDir })
    const definition = loadDefinition('design')
    writeModule(
      definition,
      'my-initiative',
      'background',
      { status: 'draft', owner: 'c.barlow', fields: {} },
      { instancesDir: workspaceDir }
    )

    const registry = listRegistry({ instancesDir })
    assert.equal(registry[0].assignee, '')
  })
})

// #145: the row's own `name` field is the instance's optional display name (`name:` in
// instance.yaml) verbatim — `null`, not the slug, when unset, so a listing screen can decide its own
// slug fallback rather than this row silently baking one in.
test('listRegistry surfaces the instance\'s display name, or null when instance.yaml has no name: set', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'my-initiative', { instancesDir: workspaceDir })
    const instancePath = join(workspaceDir, 'my-initiative', 'instance.yaml')
    writeFileSync(instancePath, readFileSync(instancePath, 'utf8') + 'name: Trerado EA Platform\n')

    createInstance('design', 'unnamed-initiative', { instancesDir: workspaceDir })

    const registry = listRegistry({ instancesDir })
    assert.equal(registry.find((i) => i.slug === 'my-initiative').name, 'Trerado EA Platform')
    assert.equal(registry.find((i) => i.slug === 'unnamed-initiative').name, null)
  })
})

test('listRegistry returns an empty array when instancesDir has no instances', async () => {
  await withScratchInstances((instancesDir) => {
    assert.deepEqual(listRegistry({ instancesDir }), [])
  })
})

test('listRegistry excludes an archived instance by default, and includes it (with archived: true) on includeArchived (#223)', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'alpha-initiative', { instancesDir: workspaceDir })
    createInstance('design', 'zebra-initiative', { instancesDir: workspaceDir })
    // Backfill both, then archive one.
    listRegistry({ instancesDir })
    archiveInstance('zebra-initiative', { instancesDir })

    assert.deepEqual(
      listRegistry({ instancesDir }).map((i) => i.slug),
      ['alpha-initiative']
    )
    // Default rows carry no `archived` key at all — shape unchanged from before #223.
    assert.equal('archived' in listRegistry({ instancesDir })[0], false)

    const withArchived = listRegistry({ instancesDir, includeArchived: true })
    assert.deepEqual(
      withArchived.map((i) => ({ slug: i.slug, archived: i.archived })),
      [
        { slug: 'alpha-initiative', archived: false },
        { slug: 'zebra-initiative', archived: true },
      ]
    )
  })
})

test('listRegistry skips a stale registry entry (instance deleted from disk after being registered), without failing the whole listing', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'alpha-initiative', { instancesDir: workspaceDir })
    createInstance('design', 'zebra-initiative', { instancesDir: workspaceDir })
    // Backfills both slugs into the registry file.
    listRegistry({ instancesDir })

    // Simulates an instance directory removed after the registry already knows about it (manual cleanup, a rename, a future delete feature) — the registry itself has no way to notice this on its own.
    rmSync(join(workspaceDir, 'alpha-initiative'), { recursive: true, force: true })

    const registry = listRegistry({ instancesDir })
    assert.deepEqual(
      registry.map((i) => i.slug),
      ['zebra-initiative']
    )
  })
})

test('listRegistry still throws on a genuine read failure, rather than silently skipping it the way a stale/missing entry is', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'broken-initiative', { instancesDir: workspaceDir })
    // Unlike a *missing* instance.yaml (readInstance's "No instance ..." error, which listRegistry deliberately skips), a present-but-unparseable instance.yaml is a real problem that must still surface — it isn't the "instance was deleted after being registered" case the stale-entry skip above exists for.
    writeFileSync(join(workspaceDir, 'broken-initiative', 'instance.yaml'), ': not: valid: yaml: [')

    assert.throws(() => listRegistry({ instancesDir }), /Nested mappings/)
  })
})

// WI #358: the real bundled fixtures now live at `workspaces/examples/kiwi-cover-mutual` and
// `workspaces/examples/gantry`, inside a real server workspace folder — no longer an example of
// this "bare, unmigrated" state. Proven directly against a scratch fixture instead.
test('listRegistry does not discover a bare (workspace-unqualified) instance directory — that requires migration first', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'bare-initiative', { instancesDir })
    assert.deepEqual(listRegistry({ instancesDir }), [])
  })
})

// #24: listRegistry's remote-row dispatch used to be an `if (kind === 'github') ... else` that
// silently ran the Azure DevOps row builder against *any* other kind — exactly the anti-pattern
// ADR-0039 rejected, and one a genuinely third-provider (e.g. GitLab, ADR-0041) entry would have hit
// before that provider's own builder ever existed. A stub third-provider kind (never a real,
// registered one — this registry has no `buildGitLabRow` yet) proves the dispatch table now reports
// it cleanly and omits the row, rather than mis-running Azure DevOps's builder against fields it
// doesn't understand (which would surface as a confusing network/validation error instead of a clean
// omission) — other, known-kind rows are unaffected.
test('listRegistry omits a row whose registry entry has an unregistered location kind, without mis-running another provider\'s builder against it', async () => {
  await withScratchInstances(async (instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir)
    createInstance('design', 'local-initiative', { instancesDir: workspaceDir })
    // Backfills 'local-initiative' into the registry file, then injects a hand-crafted entry no real
    // registration path can produce (registerInstance's own assertValidEntryKind already rejects any
    // kind besides directory/azureDevOps/github) — the "stub third-provider case" this dispatch table
    // must still route correctly rather than crash or silently misattribute.
    listRegistry({ instancesDir })
    const registryPath = join(instancesDir, 'instance-registry.json')
    const entries = JSON.parse(readFileSync(registryPath, 'utf8'))
    entries['stub-scope'] = { 'stub-initiative': { kind: 'stub-provider' } }
    writeFileSync(registryPath, JSON.stringify(entries))

    const registry = await listRegistry({ instancesDir })
    assert.deepEqual(
      registry.map((row) => row.slug),
      ['local-initiative']
    )
  })
})

// ---------- #102: the `workspace` field, for the Workspaces dashboard's grouping ----------

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SEED_FILES = {
  '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/instance-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/instance-two/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
}

test('listRegistry carries a directory-kind `workspace` field on a server-workspace-backed row (WI #357), read from that workspace\'s own workspace.json', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, 'examples')
    createInstance('design', 'my-initiative', { instancesDir: workspaceDir })
    const registry = listRegistry({ instancesDir })
    assert.deepEqual(registry[0].workspace, { kind: 'directory', id: 'examples', name: 'examples' })
  })
})

test('listRegistry surfaces a server workspace\'s optional workspace.json description as row.workspace.description (WI #357)', async () => {
  await withScratchInstances((instancesDir) => {
    writeWorkspaceJson(instancesDir, 'examples', {
      name: 'Examples',
      description: 'Bundled with Gantry',
      kind: 'local',
      createdAt: new Date().toISOString(),
    })
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'examples') })
    const registry = listRegistry({ instancesDir })
    assert.deepEqual(registry[0].workspace, {
      kind: 'directory',
      id: 'examples',
      name: 'Examples',
      description: 'Bundled with Gantry',
    })
  })
})

test('listRegistry carries a `workspace` field on an Azure-DevOps-backed row, matching the workspace its location was registered against', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
      async (adoBaseUrl) => {
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        const registry = await listRegistry({ instancesDir, pat: VALID_PAT })
        const row = registry.find((i) => i.slug === 'remote-initiative')
        assert.equal(row.workspace.organization, ORGANIZATION)
        assert.equal(row.workspace.project, PROJECT)
        assert.equal(row.workspace.repository, REPOSITORY)
        assert.equal(typeof row.workspace.id, 'string')
        assert.deepEqual(
          { stageNumber: row.stageNumber, stageCount: row.stageCount, stageTitle: row.stageTitle, pullRequestId: row.pullRequestId },
          { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null }
        )
        assert.doesNotThrow(() => new Date(row.updatedAt).toISOString())
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('listRegistry uses the current stage branch for a workspace row and carries its open PR id', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    const branch = 'gantry-workspace/remote-initiative/shape'
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: { '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nstage: shape\n' },
        branchFiles: {
          [branch]: {
            '/gantry-workspace/remote-initiative/instance.yaml':
              'definition: design\nstage: shape\npullRequests:\n  shape: 42\n',
          },
        },
      },
      async (adoBaseUrl) => {
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        const row = (await listRegistry({ instancesDir, pat: VALID_PAT }))[0]
        assert.equal(row.pullRequestId, 42)
        assert.ok(row.updatedAt)
        assert.doesNotThrow(() => new Date(row.updatedAt).toISOString())
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('listRegistry gives two instances registered against the same Azure DevOps location the same `workspace.id` — the dashboard\'s own grouping key', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
      async (adoBaseUrl) => {
        const location = { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }
        registerInstance('instance-one', location, { instancesDir })
        registerInstance('instance-two', location, { instancesDir })

        const registry = await listRegistry({ instancesDir, pat: VALID_PAT })
        const one = registry.find((i) => i.slug === 'instance-one')
        const two = registry.find((i) => i.slug === 'instance-two')
        assert.equal(one.workspace.id, two.workspace.id)
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- #121 (parent #109, docs/adr/0047): options.sharedPats — a shared workspace renders its
// listing with no viewer credential ----------
//
// `withFakeGitHubServer` (the shared helper other suites use) doesn't hand back the underlying
// `node:http` server, so `withCountingFakeGitHubServer` below is a small local wrapper (mirroring
// tests/workspaceBootstrap.test.js's own `withFakeGitHubServerCountingListFolder`) that does, purely
// so the cross-workspace-leak test can prove a *different* workspace's own repo received zero
// requests — not just that its row was omitted, which a credential-less buildGitHubRow already omits
// before ever making a network call.
function withCountingFakeGitHubServer(opts, fn) {
  const server = createFakeGitHubServer(opts)
  let requestCount = 0
  server.on('request', () => {
    requestCount++
  })
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn({ baseUrl: `http://localhost:${port}`, requestCount: () => requestCount })
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

const SHARED_GITHUB_OWN_PAT = 'own-request-pat'
const SHARED_GITHUB_SHARED_PAT = 'deployment-shared-pat'
const GITHUB_INITIATIVE_FILES = {
  '/gantry-workspace/gh-initiative/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
}

test('listRegistry: a request with no credential gets a shared workspace\'s rows, built with GANTRY_SHARED_WORKSPACE_PATS\' own entry', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'shared-owner', repository: 'shared-repo', validPat: SHARED_GITHUB_SHARED_PAT, files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl }) => {
        const location = { kind: 'github', owner: 'shared-owner', repository: 'shared-repo', baseUrl }
        registerInstance('gh-initiative', location, { instancesDir })
        const workspaceId = findWorkspaceByLocation(
          { provider: 'github', location: { owner: 'shared-owner', repository: 'shared-repo', baseUrl } },
          { instancesDir }
        ).id

        const registry = await listRegistry({ instancesDir, sharedPats: { [workspaceId]: SHARED_GITHUB_SHARED_PAT } })
        assert.deepEqual(registry.map((r) => r.slug), ['gh-initiative'])
      }
    )
  })
})

test('listRegistry: a request WITH its own credential uses its own, never the shared one, even when a (deliberately wrong) shared entry also exists', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'own-owner', repository: 'own-repo', validPat: SHARED_GITHUB_OWN_PAT, files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl }) => {
        const location = { kind: 'github', owner: 'own-owner', repository: 'own-repo', baseUrl }
        registerInstance('gh-initiative', location, { instancesDir })
        const workspaceId = findWorkspaceByLocation(
          { provider: 'github', location: { owner: 'own-owner', repository: 'own-repo', baseUrl } },
          { instancesDir }
        ).id

        // The shared entry is a PAT this fake server does not accept — if it were ever used instead of
        // the request's own, the row would be silently omitted (buildGitHubRow's own "any read failure
        // omits the row" contract) rather than merely built wrong, so its presence here is proof the
        // request's own credential was actually the one used.
        const registry = await listRegistry({
          instancesDir,
          pat: SHARED_GITHUB_OWN_PAT,
          sharedPats: { [workspaceId]: 'not-a-real-pat-and-never-tried' },
        })
        assert.deepEqual(registry.map((r) => r.slug), ['gh-initiative'])
      }
    )
  })
})

test('listRegistry: a workspace with no shared-credential entry is unchanged — its row is omitted for a credential-less request', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'unshared-owner', repository: 'unshared-repo', validPat: 'irrelevant-pat', files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl }) => {
        const location = { kind: 'github', owner: 'unshared-owner', repository: 'unshared-repo', baseUrl }
        registerInstance('gh-initiative', location, { instancesDir })

        // sharedPats has entries, just none for this workspace's own id.
        const registry = await listRegistry({ instancesDir, sharedPats: { 'some-other-workspace-id': 'some-other-pat' } })
        assert.deepEqual(registry, [])
      }
    )
  })
})

test('listRegistry: with an empty/unset shared-credential map, behavior is identical to before this ticket — a credential-less request still sees nothing for a Provider-backed instance', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'plain-owner', repository: 'plain-repo', validPat: 'irrelevant-pat', files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl }) => {
        const location = { kind: 'github', owner: 'plain-owner', repository: 'plain-repo', baseUrl }
        registerInstance('gh-initiative', location, { instancesDir })

        // Neither call passes sharedPats at all — this is every caller of listRegistry before #121,
        // and every write-path re-read in lib/server.js after it.
        assert.deepEqual(await listRegistry({ instancesDir }), [])
        assert.deepEqual(await listRegistry({ instancesDir, sharedPats: {} }), [])
      }
    )
  })
})

test('listRegistry: a shared credential scoped to workspace A is never tried against workspace B\'s repo', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'workspace-a-owner', repository: 'workspace-a-repo', validPat: 'pat-for-a', files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl: baseUrlA }) => {
        await withCountingFakeGitHubServer(
          {
            owner: 'workspace-b-owner',
            repository: 'workspace-b-repo',
            validPat: 'pat-for-b',
            files: { '/gantry-workspace/gh-initiative-b/instance.yaml': 'definition: design\nstage: shape\n' },
          },
          async ({ baseUrl: baseUrlB, requestCount: requestCountB }) => {
            const locationA = { kind: 'github', owner: 'workspace-a-owner', repository: 'workspace-a-repo', baseUrl: baseUrlA }
            const locationB = { kind: 'github', owner: 'workspace-b-owner', repository: 'workspace-b-repo', baseUrl: baseUrlB }
            registerInstance('gh-initiative', locationA, { instancesDir })
            registerInstance('gh-initiative-b', locationB, { instancesDir })
            const workspaceIdA = findWorkspaceByLocation(
              { provider: 'github', location: { owner: 'workspace-a-owner', repository: 'workspace-a-repo', baseUrl: baseUrlA } },
              { instancesDir }
            ).id

            // Only A has a shared entry — B has none at all.
            const registry = await listRegistry({ instancesDir, sharedPats: { [workspaceIdA]: 'pat-for-a' } })
            assert.deepEqual(
              registry.map((r) => r.slug),
              ['gh-initiative']
            )
            assert.equal(requestCountB(), 0, "workspace A's shared credential must never be tried against workspace B's repo")
          }
        )
      }
    )
  })
})

test('listRegistry: no shared credential ever appears in the built rows', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withCountingFakeGitHubServer(
      { owner: 'secret-owner', repository: 'secret-repo', validPat: SHARED_GITHUB_SHARED_PAT, files: GITHUB_INITIATIVE_FILES },
      async ({ baseUrl }) => {
        const location = { kind: 'github', owner: 'secret-owner', repository: 'secret-repo', baseUrl }
        registerInstance('gh-initiative', location, { instancesDir })
        const workspaceId = findWorkspaceByLocation(
          { provider: 'github', location: { owner: 'secret-owner', repository: 'secret-repo', baseUrl } },
          { instancesDir }
        ).id

        const registry = await listRegistry({ instancesDir, sharedPats: { [workspaceId]: SHARED_GITHUB_SHARED_PAT } })
        assert.ok(!JSON.stringify(registry).includes(SHARED_GITHUB_SHARED_PAT))
      }
    )
  })
})
