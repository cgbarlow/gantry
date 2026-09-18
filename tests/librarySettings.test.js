import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addLibraryRepo,
  listLibraryRepos,
  resolveLibraryRepo,
  findLibraryRepoByLocation,
  updateLibraryRepoCodeOwner,
} from '../lib/librarySettings.js'

// #19 (ADR-0037): library repos gain the same `{ provider, location }` nested shape a workspace
// does — Azure DevOps's pre-#19 flat `{ organization, project, repository, baseUrl? }` input/output
// keeps working unchanged (`lib/definitionPromote.js` depends on it), GitHub takes
// `{ owner, repository, baseUrl? }`, and a pre-#19 flat record on disk is read forward
// (auto-backfill-on-read, never a one-shot migration — mirrors lib/instanceRegistry.js's own
// `migrateLegacyFlatShape` convention).

function withScratchDir(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'library-settings-'))
  try {
    return fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('addLibraryRepo accepts the pre-#19 flat shape and returns it with provider/location alongside the flat aliases', () => {
  withScratchDir((instancesDir) => {
    const repo = addLibraryRepo({ organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })
    assert.equal(repo.provider, 'azure-devops')
    assert.deepEqual(repo.location, { organization: 'org', project: 'proj', repository: 'repo' })
    // Flat aliases still present — lib/definitionPromote.js reads these directly, unmigrated.
    assert.equal(repo.organization, 'org')
    assert.equal(repo.project, 'proj')
    assert.equal(repo.repository, 'repo')
  })
})

test('addLibraryRepo accepts the nested GitHub shape and carries no flat organization/project aliases', () => {
  withScratchDir((instancesDir) => {
    const repo = addLibraryRepo({ provider: 'github', location: { owner: 'acme', repository: 'defs' } }, { instancesDir })
    assert.equal(repo.provider, 'github')
    assert.deepEqual(repo.location, { owner: 'acme', repository: 'defs' })
    assert.equal(repo.organization, undefined)
    assert.equal(repo.project, undefined)
  })
})

test('addLibraryRepo rejects an unsupported provider, and a GitHub location missing owner or repository', () => {
  withScratchDir((instancesDir) => {
    assert.throws(() => addLibraryRepo({ provider: 'atlassian', location: {} }, { instancesDir }), /Unsupported library repo provider "atlassian"/)
    assert.throws(() => addLibraryRepo({ provider: 'github', location: { owner: 'acme' } }, { instancesDir }), /is missing: repository/)
    assert.throws(() => addLibraryRepo({ provider: 'github', location: { repository: 'defs' } }, { instancesDir }), /is missing: owner/)
  })
})

test('addLibraryRepo rejects an Azure DevOps location missing organization, project or repository', () => {
  withScratchDir((instancesDir) => {
    assert.throws(() => addLibraryRepo({ organization: 'org' }, { instancesDir }), /is missing: project, repository/)
  })
})

test('Azure DevOps and GitHub library repos coexist in listLibraryRepos, each keeping its own shape', () => {
  withScratchDir((instancesDir) => {
    const ado = addLibraryRepo({ organization: 'org', project: 'proj', repository: 'ado-repo' }, { instancesDir })
    const gh = addLibraryRepo({ provider: 'github', location: { owner: 'acme', repository: 'gh-repo' } }, { instancesDir })
    const listed = listLibraryRepos({ instancesDir })
    assert.equal(listed.length, 2)
    assert.deepEqual(listed.map((r) => r.id).sort(), [ado.id, gh.id].sort())
    assert.equal(resolveLibraryRepo(ado.id, { instancesDir }).provider, 'azure-devops')
    assert.equal(resolveLibraryRepo(gh.id, { instancesDir }).provider, 'github')
  })
})

test('a pre-#19 flat record on disk is read forward into the nested shape, and rewritten on next write', () => {
  withScratchDir((instancesDir) => {
    const path = join(instancesDir, 'library-repos.json')
    writeFileSync(
      path,
      JSON.stringify({ 'legacy-id': { organization: 'org', project: 'proj', repository: 'repo', codeOwner: 'alice', addedAt: '2020-01-01T00:00:00.000Z' } }, null, 2)
    )
    const repo = resolveLibraryRepo('legacy-id', { instancesDir })
    assert.equal(repo.provider, 'azure-devops')
    assert.deepEqual(repo.location, { organization: 'org', project: 'proj', repository: 'repo' })
    assert.equal(repo.codeOwner, 'alice')
    assert.equal(repo.organization, 'org', 'flat alias still present after backfill')

    // Rewritten on disk into the nested shape (auto-backfill-on-read, not left flat).
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(onDisk['legacy-id'].provider, 'azure-devops')
    assert.deepEqual(onDisk['legacy-id'].location, { organization: 'org', project: 'proj', repository: 'repo' })
  })
})

test('findLibraryRepoByLocation matches within one provider only — same repo name on two providers never collides', () => {
  withScratchDir((instancesDir) => {
    const ado = addLibraryRepo({ organization: 'acme', project: 'proj', repository: 'defs' }, { instancesDir })
    const gh = addLibraryRepo({ provider: 'github', location: { owner: 'acme', repository: 'defs' } }, { instancesDir })

    assert.equal(findLibraryRepoByLocation({ organization: 'acme', project: 'proj', repository: 'defs' }, { instancesDir }).id, ado.id)
    assert.equal(findLibraryRepoByLocation({ provider: 'github', location: { owner: 'acme', repository: 'defs' } }, { instancesDir }).id, gh.id)
    assert.equal(findLibraryRepoByLocation({ provider: 'github', location: { owner: 'acme', repository: 'nope' } }, { instancesDir }), undefined)
  })
})

test('updateLibraryRepoCodeOwner works for a GitHub repo the same way it does for Azure DevOps', () => {
  withScratchDir((instancesDir) => {
    const gh = addLibraryRepo({ provider: 'github', location: { owner: 'acme', repository: 'defs' } }, { instancesDir })
    const updated = updateLibraryRepoCodeOwner(gh.id, 'bob', { instancesDir })
    assert.equal(updated.codeOwner, 'bob')
    assert.equal(updated.provider, 'github')
    const cleared = updateLibraryRepoCodeOwner(gh.id, '', { instancesDir })
    assert.equal(cleared.codeOwner, undefined)
  })
})
