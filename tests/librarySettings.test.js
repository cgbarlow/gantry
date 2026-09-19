import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  listLibraryRepos,
  resolveLibraryRepo,
  addLibraryRepo,
  updateLibraryRepoCodeOwner,
  removeLibraryRepo,
  findLibraryRepoByLocation,
} from '../lib/librarySettings.js'
import { withScratchInstances } from './helpers/lifecycle.js'

const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
const GITHUB_LOCATION = { owner: 'octocat', repository: 'fake-repo' }
const GITLAB_LOCATION = { namespace: 'engineering/platform', repository: 'fake-repo' }

// ---------- addLibraryRepo: nested {provider, location} shape only (ticket #6) ----------

test('addLibraryRepo persists location, generates an id and addedAt', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ location: LOCATION }, { instancesDir })
    assert.equal(typeof repo.id, 'string')
    assert.ok(repo.id.length > 0)
    assert.deepEqual(repo.location, LOCATION)
    assert.equal(typeof repo.addedAt, 'string')
  })
})

test('addLibraryRepo persists an optional codeOwner and baseUrl', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ location: { ...LOCATION, baseUrl: 'https://ado.example.internal' }, codeOwner: 'c.barlow' }, { instancesDir })
    assert.equal(repo.location.baseUrl, 'https://ado.example.internal')
    assert.equal(repo.codeOwner, 'c.barlow')
  })
})

test('addLibraryRepo rejects a location missing organization/project/repository', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => addLibraryRepo({ location: { organization: 'org' } }, { instancesDir }), /missing: project, repository/)
  })
})

test('addLibraryRepo rejects a location with no location key at all — flat input is no longer accepted', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => addLibraryRepo({ ...LOCATION }, { instancesDir }), /missing: organization, project, repository/)
  })
})

test('addLibraryRepo always creates a fresh id, even for a repeated location', async () => {
  await withScratchInstances((instancesDir) => {
    const first = addLibraryRepo({ location: LOCATION }, { instancesDir })
    const second = addLibraryRepo({ location: LOCATION }, { instancesDir })
    assert.notEqual(first.id, second.id)
    assert.equal(listLibraryRepos({ instancesDir }).length, 2)
  })
})

// ---------- provider + nested location (#3, ADR-0037) ----------

test('addLibraryRepo accepts the nested {provider, location} shape for an Azure DevOps repo', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ provider: 'azure-devops', location: LOCATION, codeOwner: 'c.barlow' }, { instancesDir })
    assert.equal(repo.provider, 'azure-devops')
    assert.deepEqual(repo.location, LOCATION)
    assert.equal(repo.codeOwner, 'c.barlow')
  })
})

test('addLibraryRepo accepts a GitHub {provider, location} — owner/repository, no project required', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })
    assert.equal(repo.provider, 'github')
    assert.deepEqual(repo.location, GITHUB_LOCATION)
    // No location accessor exists at all any more (ticket #6).
    assert.equal(repo.organization, undefined)
  })
})

test('addLibraryRepo rejects a GitHub location missing owner or repository', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => addLibraryRepo({ provider: 'github', location: { owner: 'octocat' } }, { instancesDir }), /missing: repository/)
  })
})

test('addLibraryRepo accepts a GitLab {provider, location} — namespace/repository, no project required (ADR-0041)', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ provider: 'gitlab', location: GITLAB_LOCATION }, { instancesDir })
    assert.equal(repo.provider, 'gitlab')
    assert.deepEqual(repo.location, GITLAB_LOCATION)
    // No location accessor exists at all any more (ticket #6).
    assert.equal(repo.organization, undefined)
  })
})

test('addLibraryRepo accepts a GitLab location with a self-hosted baseUrl', async () => {
  await withScratchInstances((instancesDir) => {
    const repo = addLibraryRepo({ provider: 'gitlab', location: { ...GITLAB_LOCATION, baseUrl: 'https://gitlab.example.internal' } }, { instancesDir })
    assert.equal(repo.location.baseUrl, 'https://gitlab.example.internal')
  })
})

test('addLibraryRepo rejects a GitLab location missing namespace or repository', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => addLibraryRepo({ provider: 'gitlab', location: { namespace: 'engineering' } }, { instancesDir }), /missing: repository/)
    assert.throws(() => addLibraryRepo({ provider: 'gitlab', location: { repository: 'fake-repo' } }, { instancesDir }), /missing: namespace/)
  })
})

test('addLibraryRepo rejects an unknown or unsupported provider', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => addLibraryRepo({ provider: 'trello', location: {} }, { instancesDir }), /Unknown provider/)
    assert.throws(() => addLibraryRepo({ provider: 'atlassian', location: {} }, { instancesDir }), /not supported yet/)
  })
})

// ---------- listLibraryRepos / resolveLibraryRepo ----------

test('listLibraryRepos returns repos in insertion order', async () => {
  await withScratchInstances((instancesDir) => {
    const first = addLibraryRepo({ location: LOCATION }, { instancesDir })
    const second = addLibraryRepo({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })
    assert.deepEqual(listLibraryRepos({ instancesDir }).map((r) => r.id), [first.id, second.id])
  })
})

test('resolveLibraryRepo round-trips a registered repo by id, and returns undefined for an unknown one', async () => {
  await withScratchInstances((instancesDir) => {
    const created = addLibraryRepo({ location: LOCATION }, { instancesDir })
    assert.deepEqual(resolveLibraryRepo(created.id, { instancesDir }), created)
    assert.equal(resolveLibraryRepo('nowhere', { instancesDir }), undefined)
  })
})

test('resolveLibraryRepo returns undefined for "__proto__" — an inherited property, never a real registry entry', async () => {
  await withScratchInstances((instancesDir) => {
    addLibraryRepo({ location: LOCATION }, { instancesDir })
    assert.equal(resolveLibraryRepo('__proto__', { instancesDir }), undefined)
  })
})

// ---------- updateLibraryRepoCodeOwner / removeLibraryRepo ----------

test('updateLibraryRepoCodeOwner sets and clears codeOwner', async () => {
  await withScratchInstances((instancesDir) => {
    const created = addLibraryRepo({ location: LOCATION }, { instancesDir })
    const withOwner = updateLibraryRepoCodeOwner(created.id, 'c.barlow', { instancesDir })
    assert.equal(withOwner.codeOwner, 'c.barlow')

    const cleared = updateLibraryRepoCodeOwner(created.id, '', { instancesDir })
    assert.equal(cleared.codeOwner, undefined)
  })
})

test('updateLibraryRepoCodeOwner throws for an unknown id', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => updateLibraryRepoCodeOwner('nowhere', 'x', { instancesDir }), /Unknown library repo/)
  })
})

test('removeLibraryRepo removes a repo, idempotently', async () => {
  await withScratchInstances((instancesDir) => {
    const created = addLibraryRepo({ location: LOCATION }, { instancesDir })
    removeLibraryRepo(created.id, { instancesDir })
    assert.equal(resolveLibraryRepo(created.id, { instancesDir }), undefined)
    assert.doesNotThrow(() => removeLibraryRepo(created.id, { instancesDir }))
  })
})

// ---------- findLibraryRepoByLocation: provider-scoped matching (ADR-0037) ----------

test('findLibraryRepoByLocation matches within a provider only — a GitHub repo sharing a repository name with an Azure DevOps one is distinct', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = addLibraryRepo({ location: { organization: 'shared', project: 'shared', repository: 'shared-repo' } }, { instancesDir })
    const gh = addLibraryRepo({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })

    assert.deepEqual(
      findLibraryRepoByLocation({ location: { organization: 'shared', project: 'shared', repository: 'shared-repo' } }, { instancesDir }),
      ado
    )
    assert.deepEqual(
      findLibraryRepoByLocation({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir }),
      gh
    )
  })
})

test('findLibraryRepoByLocation scopes GitLab separately too — a GitLab repo sharing a repository name with a GitHub one is distinct', async () => {
  await withScratchInstances((instancesDir) => {
    const gh = addLibraryRepo({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })
    const gl = addLibraryRepo({ provider: 'gitlab', location: { namespace: 'shared', repository: 'shared-repo' } }, { instancesDir })

    assert.deepEqual(findLibraryRepoByLocation({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir }), gh)
    assert.deepEqual(findLibraryRepoByLocation({ provider: 'gitlab', location: { namespace: 'shared', repository: 'shared-repo' } }, { instancesDir }), gl)
  })
})

test('findLibraryRepoByLocation returns undefined when nothing matches', async () => {
  await withScratchInstances((instancesDir) => {
    addLibraryRepo({ location: LOCATION }, { instancesDir })
    assert.equal(findLibraryRepoByLocation({ location: { organization: 'other', project: 'p', repository: 'r' } }, { instancesDir }), undefined)
  })
})

// ---------- read-forward: a pre-#3 flat record is lifted into {provider, location}, rewritten on next write ----------

function writeLegacyFlatRepos(instancesDir, entries) {
  mkdirSync(instancesDir, { recursive: true })
  writeFileSync(join(instancesDir, 'library-repos.json'), JSON.stringify(entries, null, 2) + '\n')
}

test('a pre-#3 flat library repo record is read forward as provider: "azure-devops" with its fields lifted into location', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-repo-1'
    writeLegacyFlatRepos(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', codeOwner: 'a.person', addedAt: '2026-01-01T00:00:00.000Z' },
    })

    const resolved = resolveLibraryRepo(legacyId, { instancesDir })
    assert.equal(resolved.provider, 'azure-devops')
    assert.deepEqual(resolved.location, { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' })
    assert.equal(resolved.codeOwner, 'a.person')
    assert.equal(resolved.addedAt, '2026-01-01T00:00:00.000Z')
  })
})

test('a pre-#3 flat library repo record is rewritten to the nested shape on disk the first time it is read', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-repo-2'
    writeLegacyFlatRepos(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', addedAt: '2026-01-01T00:00:00.000Z' },
    })

    resolveLibraryRepo(legacyId, { instancesDir })

    const path = join(instancesDir, 'library-repos.json')
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(persisted[legacyId], {
      provider: 'azure-devops',
      location: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' },
      addedAt: '2026-01-01T00:00:00.000Z',
    })
  })
})

test('read-forward is idempotent for library repos — reading an already-migrated record twice does not rewrite again', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-repo-3'
    writeLegacyFlatRepos(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', addedAt: '2026-01-01T00:00:00.000Z' },
    })

    listLibraryRepos({ instancesDir })
    const path = join(instancesDir, 'library-repos.json')
    const afterFirstRead = readFileSync(path, 'utf8')
    listLibraryRepos({ instancesDir })
    const afterSecondRead = readFileSync(path, 'utf8')

    assert.equal(afterFirstRead, afterSecondRead)
  })
})
