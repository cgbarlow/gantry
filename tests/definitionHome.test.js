import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  serverWorkspaceDefinitionsDir,
  listServerWorkspaceHomes,
  listDefinitionsAcrossHomes,
  findDefinitionHomeDefinitionsDir,
  definitionIdExistsIn,
  assertDefinitionIdAvailable,
  DefinitionIdConflictError,
  definitionsDirForInstanceScope,
} from '../lib/definitionHome.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition } from '../lib/definition.js'

// WI #383 (Definition Editor phase 3, ADR-0036): resolution across the server library and every
// server workspace's own `definitions/` folder, and the id-uniqueness guard ("no shadowing").

function withTempDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-home-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-home-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    return fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function makeServerWorkspace(instancesDir, id, name) {
  mkdirSync(join(instancesDir, id), { recursive: true })
  writeWorkspaceJson(instancesDir, id, { name, kind: 'local', createdAt: new Date().toISOString() })
  return serverWorkspaceDefinitionsDir(instancesDir, id)
}

test('serverWorkspaceDefinitionsDir points at <instancesDir>/<workspace>/definitions', () => {
  assert.equal(serverWorkspaceDefinitionsDir('workspaces', 'acme'), join('workspaces', 'acme', 'definitions'))
})

test('listServerWorkspaceHomes lists every workspace with a workspace.json, skipping one that fails to parse', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    makeServerWorkspace(instancesDir, 'acme', 'Acme')
    makeServerWorkspace(instancesDir, 'beta', 'Beta Team')
    // A directory with no workspace.json at all is not a server workspace.
    mkdirSync(join(instancesDir, 'not-a-workspace'), { recursive: true })
    const homes = listServerWorkspaceHomes(instancesDir)
    assert.deepEqual(
      homes.map((h) => h.id),
      ['acme', 'beta']
    )
    assert.equal(homes.find((h) => h.id === 'acme').name, 'Acme')
  })
})

test('listDefinitionsAcrossHomes without includeWorkspaces returns exactly listDefinitions\'s library rows, each tagged home: library', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    makeServerWorkspace(instancesDir, 'acme', 'Acme')
    const rows = listDefinitionsAcrossHomes({ definitionsDir, instancesDir })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'design')
    assert.deepEqual(rows[0].home, { kind: 'library' })
  })
})

test('listDefinitionsAcrossHomes with includeWorkspaces unions the library with every server workspace, tagged by home', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    const acmeDefs = makeServerWorkspace(instancesDir, 'acme', 'Acme')
    createBlankDefinition('acme-only', { definitionsDir: acmeDefs, title: 'Acme Only' })

    const rows = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true })
    const ids = rows.map((r) => r.id)
    assert.deepEqual(ids, ['design', 'acme-only'])
    const workspaceRow = rows.find((r) => r.id === 'acme-only')
    assert.deepEqual(workspaceRow.home, { kind: 'server-workspace', id: 'acme', name: 'Acme' })
  })
})

test('findDefinitionHomeDefinitionsDir finds a workspace-only id, an id that only exists in the library, and reports null for an id nowhere', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    const acmeDefs = makeServerWorkspace(instancesDir, 'acme', 'Acme')
    createBlankDefinition('acme-only', { definitionsDir: acmeDefs })

    assert.equal(findDefinitionHomeDefinitionsDir('design', { definitionsDir, instancesDir }), definitionsDir)
    assert.equal(findDefinitionHomeDefinitionsDir('acme-only', { definitionsDir, instancesDir }), acmeDefs)
    assert.equal(findDefinitionHomeDefinitionsDir('does-not-exist', { definitionsDir, instancesDir }), null)
  })
})

test('definitionIdExistsIn is true for a real definition and false for an unknown one or a missing directory', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    assert.equal(definitionIdExistsIn(definitionsDir, 'design'), true)
    assert.equal(definitionIdExistsIn(definitionsDir, 'nope'), false)
    assert.equal(definitionIdExistsIn(join(instancesDir, 'does-not-exist'), 'design'), false)
  })
})

test('assertDefinitionIdAvailable throws DefinitionIdConflictError when the id already exists in the library', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    assert.throws(() => assertDefinitionIdAvailable('design', { definitionsDir, instancesDir }), DefinitionIdConflictError)
  })
})

test('assertDefinitionIdAvailable throws DefinitionIdConflictError when the id already exists in a server workspace, even one different from any the caller is targeting — no shadowing', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    const acmeDefs = makeServerWorkspace(instancesDir, 'acme', 'Acme')
    createBlankDefinition('shared-id', { definitionsDir: acmeDefs })
    assert.throws(() => assertDefinitionIdAvailable('shared-id', { definitionsDir, instancesDir }), DefinitionIdConflictError)
  })
})

test('assertDefinitionIdAvailable throws DefinitionIdConflictError for an id present in extraKnownIds (an Azure DevOps workspace\'s own already-fetched ids)', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    assert.throws(
      () => assertDefinitionIdAvailable('ado-only', { definitionsDir, instancesDir, extraKnownIds: ['ado-only'] }),
      DefinitionIdConflictError
    )
  })
})

test('assertDefinitionIdAvailable throws a plain (non-conflict) Error for an invalid slug', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    assert.throws(() => assertDefinitionIdAvailable('bad/slug', { definitionsDir, instancesDir }), (err) => {
      assert.ok(!(err instanceof DefinitionIdConflictError))
      return true
    })
  })
})

test('assertDefinitionIdAvailable does not throw for a genuinely free id', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    makeServerWorkspace(instancesDir, 'acme', 'Acme')
    assert.doesNotThrow(() => assertDefinitionIdAvailable('brand-new-id', { definitionsDir, instancesDir }))
  })
})

test('definitionsDirForInstanceScope resolves the workspace\'s own definitions dir when the pinned definition lives there, falling back to the library otherwise', () => {
  withTempDirs((definitionsDir, instancesDir) => {
    const acmeDefs = makeServerWorkspace(instancesDir, 'acme', 'Acme')
    createBlankDefinition('acme-only', { definitionsDir: acmeDefs })
    const toFolder = (scopeId) => scopeId

    // Workspace-only definition, instance scoped to that workspace: resolves to the workspace's own dir.
    assert.equal(
      definitionsDirForInstanceScope('acme-only', { definitionsDir, instancesDir, scopeId: 'acme', toFolder }),
      acmeDefs
    )
    // Library definition, same workspace scope: falls back to the library (the workspace doesn't have it).
    assert.equal(
      definitionsDirForInstanceScope('design', { definitionsDir, instancesDir, scopeId: 'acme', toFolder }),
      definitionsDir
    )
    // No scope at all (an unscoped/legacy instance): always the library.
    assert.equal(
      definitionsDirForInstanceScope('design', { definitionsDir, instancesDir, scopeId: undefined, toFolder }),
      definitionsDir
    )
    // A scope that doesn't name a real workspace folder (e.g. an Azure DevOps workspace's uuid) has no
    // local `definitions/` folder to find anything in — falls back to the library, never throws.
    assert.equal(
      definitionsDirForInstanceScope('design', { definitionsDir, instancesDir, scopeId: 'some-ado-uuid', toFolder }),
      definitionsDir
    )
  })
})
