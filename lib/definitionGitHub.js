import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { createGitHubClient, GitHubNotFoundError } from './githubClient.js'
import { isValidSlug } from './slug.js'
import {
  buildDefinitionYamlObject,
  buildModuleYamlObject,
  stageFromRaw,
  artefactFromRaw,
  moduleFromRaw,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
} from './definition.js'

/**
 * #19/#17 (ADR-0037, ADR-0039) — the GitHub-backed half of reading and writing a `definitions/`
 * folder, mirroring `lib/definitionAzureDevOps.js`'s own read/write path but over
 * `lib/githubClient.js` instead. Serves two callers, exactly like the Azure DevOps module does:
 * `lib/libraryCache.js` (read-only — a **library repo** is a read source only, ADR-0036, so it never
 * calls the write functions below) and, since #17, `lib/server.js`'s `/api/workspaces/:id/definitions*`
 * routes for a GitHub **workspace**'s own `definitions/` folder — one commit per create/save/publish/
 * archive/restore, straight to `main`, never a stage branch or PR (a workspace definition has no
 * review gate of its own to preserve — see `lib/definitionAzureDevOps.js`'s own doc comment for the
 * full reasoning, identical here).
 *
 * Same on-disk-shape assumption as the Azure DevOps path: `definitions/<id>/<n>/definition.yaml` +
 * `definitions/<id>/<n>/modules/<moduleId>.yaml`, an optional `definitions/<id>/.archived` marker,
 * draft/published version status carried in each `definition.yaml`. Reuses `lib/libraryCache.js`'s
 * caller contract exactly: `lib/libraryCache.js`'s `refreshLibraryRepo` calls
 * `listGitHubDefinitions` then `loadGitHubDefinition` per published id, the same two-call shape it
 * already uses for an Azure DevOps library repo.
 *
 * Deliberately duplicates rather than shares `lib/definitionAzureDevOps.js`'s private per-provider
 * helpers (path-building, YAML parsing) — the two clients' method shapes
 * (`getFileContent`/`listFolder`/`writeFiles`/`deleteFile`) already match closely enough that a
 * shared helper is a reasonable follow-up, but factoring it now risks designing that seam against
 * the wrong shape before a third provider exists to prove it out (same reasoning `lib/providerRegistry.js`'s
 * own doc comment gives for keeping the two Azure DevOps/GitHub implementations separate).
 *
 * The raw-YAML-to-Definition mapping is the exception (#148): it is shared from `lib/definition.js`
 * (`stageFromRaw`/`artefactFromRaw`/`moduleFromRaw`), because the per-provider copies drifted and
 * dropped keys.
 *
 * Deliberately a smaller surface than `lib/definitionAzureDevOps.js`'s: templates/reference-docx and
 * clone-from-another-definition are not implemented here either, matching that module's own scope.
 */

const DEFINITIONS_ROOT = 'definitions'

function assertValidVersion(version, definitionId) {
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  return vNum
}

function definitionDirPath(id, n) {
  return `${DEFINITIONS_ROOT}/${id}/${n}`
}
function definitionYamlPath(id, n) {
  return `${definitionDirPath(id, n)}/definition.yaml`
}
function moduleYamlPath(id, n, moduleId) {
  return `${definitionDirPath(id, n)}/modules/${moduleId}.yaml`
}
function changelogPath(id, n) {
  return `${definitionDirPath(id, n)}/CHANGELOG.md`
}
function archivedMarkerPath(id) {
  return `${DEFINITIONS_ROOT}/${id}/.archived`
}

/** Builds the GitHub client + target branch from `options.github`, the `{ owner, repository, pat, baseUrl?, branch? }` shape — mirrors `lib/definitionAzureDevOps.js`'s private `clientFor`. */
function clientFor(options) {
  const { owner, repository, pat, baseUrl, branch } = options.github
  return { client: createGitHubClient({ owner, repository, pat, baseUrl }), branch }
}

async function readYamlFile(client, path, branch) {
  const text = await client.getFileContent(path, { branch })
  return parseYAML(text)
}

async function fileExists(client, path, branch) {
  try {
    await client.getFileContent(path, { branch })
    return true
  } catch (err) {
    if (err instanceof GitHubNotFoundError) return false
    throw err
  }
}

async function listVersionNumbers(client, id, branch) {
  const entries = await client.listFolder(`${DEFINITIONS_ROOT}/${id}`, { branch })
  return entries
    .filter((entry) => entry.isFolder && /^[1-9]\d*$/.test(entry.path.split('/').pop()))
    .map((entry) => Number(entry.path.split('/').pop()))
    .sort((a, b) => a - b)
}

async function getLatestPublishedVersion(client, id, branch) {
  const versions = await listVersionNumbers(client, id, branch)
  let latest = null
  for (const v of versions) {
    const raw = await readYamlFile(client, definitionYamlPath(id, v), branch)
    if (raw.status === 'published') latest = v
  }
  return latest
}

export async function isGitHubDefinitionArchived(definitionId, options) {
  const { client, branch } = clientFor(options)
  return fileExists(client, archivedMarkerPath(definitionId), branch)
}

/** Every definition id with at least one version directory, in a GitHub library repo. */
export async function listGitHubDefinitionIds(options) {
  const { client, branch } = clientFor(options)
  const entries = await client.listFolder(DEFINITIONS_ROOT, { branch })
  const ids = []
  for (const entry of entries.filter((e) => e.isFolder)) {
    const id = entry.path.split('/').pop()
    const versions = await listVersionNumbers(client, id, branch)
    if (versions.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Loads one version of a GitHub library repo's definition — the same `{ id, title, description,
 * version, status, stages, artefacts, modules }` shape `lib/definitionAzureDevOps.js`'s
 * `loadAzureDevOpsDefinition` returns, so `lib/libraryCache.js`'s `refreshLibraryRepo` can treat the
 * two providers identically once it has this result. Only the modules a stage or artefact actually
 * references are loaded, mirroring that function's own referenced-only behaviour.
 */
export async function loadGitHubDefinition(definitionId, version, options) {
  const { client, branch } = clientFor(options)
  const vNum = assertValidVersion(version, definitionId)
  const raw = await readYamlFile(client, definitionYamlPath(definitionId, vNum), branch)

  const stages = (raw.stages ?? []).map(stageFromRaw)
  const artefacts = (raw.artefacts ?? []).map(artefactFromRaw)

  const referencedModuleIds = new Set([
    ...stages.flatMap((s) => s.modules),
    ...artefacts.flatMap((a) => a.requires.map((r) => (r.includes('.') ? r.slice(0, r.indexOf('.')) : r.replace(/\?$/, '')))),
  ])

  const modules = new Map()
  for (const moduleId of referencedModuleIds) {
    let rawModule
    try {
      rawModule = await readYamlFile(client, moduleYamlPath(definitionId, vNum, moduleId), branch)
    } catch (err) {
      if (err instanceof GitHubNotFoundError) {
        throw new Error(`Definition "${definitionId}" references module "${moduleId}", which does not exist at version ${vNum}`)
      }
      throw err
    }
    modules.set(moduleId, moduleFromRaw(rawModule))
  }

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    version: raw.version ?? vNum,
    status: raw.status ?? 'published',
    stages,
    artefacts,
    modules,
  }
}

/**
 * Every definition available in a GitHub library repo, in the same row shape
 * `lib/definitionAzureDevOps.js`'s `listAzureDevOpsDefinitions` produces — so
 * `lib/libraryCache.js`'s `refreshLibraryRepo` can treat both providers' rows identically.
 */
export async function listGitHubDefinitions(options, { includeArchived = false } = {}) {
  const { client, branch } = clientFor(options)
  const ids = await listGitHubDefinitionIds(options)
  const rows = []
  for (const id of ids.sort()) {
    const archived = await fileExists(client, archivedMarkerPath(id), branch)
    if (!includeArchived && archived) continue
    const versions = await listVersionNumbers(client, id, branch)
    const versionsWithStatus = []
    for (const v of versions) {
      const raw = await readYamlFile(client, definitionYamlPath(id, v), branch)
      versionsWithStatus.push({ version: v, status: raw.status ?? 'published' })
    }
    const latestPublished = await getLatestPublishedVersion(client, id, branch)
    const versionToLoad = latestPublished ?? Math.max(...versions)
    const definition = await loadGitHubDefinition(id, versionToLoad, options)
    const row = {
      id: definition.id,
      title: definition.title,
      description: definition.description ?? null,
      stages: definition.stages.map((s) => ({ id: s.id, title: s.title })),
      latestPublished,
      versions: versionsWithStatus,
    }
    if (includeArchived) row.archived = archived
    rows.push(row)
  }
  return rows
}

/** A brand-new, empty draft (v1) definition in a GitHub workspace's repo — one commit. Mirrors `lib/definitionAzureDevOps.js`'s `createBlankAzureDevOpsDefinition`. */
export async function createBlankGitHubDefinition(newId, options, { title } = {}) {
  if (!isValidSlug(newId)) {
    throw new Error(`Invalid slug "${newId}"`)
  }
  const { client, branch } = clientFor(options)
  if (await fileExists(client, definitionYamlPath(newId, 1), branch)) {
    throw new Error(`Definition "${newId}" already exists`)
  }
  const obj = { id: newId, version: 1, status: 'draft', title: title || newId, description: '', stages: [], artefacts: [] }
  await client.writeFiles(
    [
      { path: definitionYamlPath(newId, 1), content: stringifyYAML(obj) },
      { path: changelogPath(newId, 1), content: '## v1\n\nDraft.\n' },
    ],
    { branch, message: `Create definition "${newId}"` }
  )
  return { id: newId }
}

/** A new draft version, copied from the definition's current latest version — one commit. Mirrors `lib/definitionAzureDevOps.js`'s `createAzureDevOpsDraftVersion`, including its "carry the on-disk YAML forward verbatim" approach. */
export async function createGitHubDraftVersion(definitionId, options) {
  const { client, branch } = clientFor(options)
  const versions = await listVersionNumbers(client, definitionId, branch)
  if (versions.length === 0) {
    throw new Error(`Definition "${definitionId}" has no versions`)
  }
  if (await fileExists(client, archivedMarkerPath(definitionId), branch)) {
    throw new Error(`Definition "${definitionId}" is archived`)
  }
  const max = Math.max(...versions)
  const n = max + 1

  const defText = await client.getFileContent(definitionYamlPath(definitionId, max), { branch })
  const raw = parseYAML(defText)
  const moduleEntries = await client.listFolder(`${definitionDirPath(definitionId, max)}/modules`, { branch })
  const moduleFiles = []
  for (const entry of moduleEntries.filter((e) => !e.isFolder && e.path.endsWith('.yaml'))) {
    const moduleId = entry.path.split('/').pop().slice(0, -'.yaml'.length)
    const content = await client.getFileContent(entry.path, { branch })
    moduleFiles.push({ path: moduleYamlPath(definitionId, n, moduleId), content })
  }

  const newObj = buildDefinitionYamlObject(definitionId, n, 'draft', raw, raw)
  await client.writeFiles(
    [
      { path: definitionYamlPath(definitionId, n), content: stringifyYAML(newObj) },
      { path: changelogPath(definitionId, n), content: `## v${n}\n\nDraft.\n` },
      ...moduleFiles,
    ],
    { branch, message: `Add draft v${n} of definition "${definitionId}"` }
  )
  return { version: n }
}

/** Saves a draft version's structure — one commit, adding/editing every changed file and deleting any module file the new structure no longer wants. Mirrors `lib/definitionAzureDevOps.js`'s `writeAzureDevOpsDefinitionVersion`. */
export async function writeGitHubDefinitionVersion(definitionId, version, structure, options) {
  const { client, branch } = clientFor(options)
  const vNum = assertValidVersion(version, definitionId)

  const raw = await readYamlFile(client, definitionYamlPath(definitionId, vNum), branch)
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }
  for (const mod of structure.modules ?? []) {
    if (!isValidSlug(mod.id)) {
      throw new Error(`Invalid module id "${mod.id}"`)
    }
  }

  const problems = findDefinitionProblemsInStructure(structure)
  if (problems.length > 0) {
    return { problems }
  }

  const existingModuleEntries = await client.listFolder(`${definitionDirPath(definitionId, vNum)}/modules`, { branch })
  const existingModuleIds = new Set(
    existingModuleEntries.filter((e) => !e.isFolder && e.path.endsWith('.yaml')).map((e) => e.path.split('/').pop().slice(0, -'.yaml'.length))
  )
  const wantedModuleIds = new Set((structure.modules ?? []).map((m) => m.id))
  const deletePaths = [...existingModuleIds]
    .filter((id) => !wantedModuleIds.has(id))
    .map((id) => moduleYamlPath(definitionId, vNum, id))

  const defObj = buildDefinitionYamlObject(definitionId, raw.version, raw.status, structure, raw)
  const files = [
    { path: definitionYamlPath(definitionId, vNum), content: stringifyYAML(defObj) },
    ...(structure.modules ?? []).map((mod) => ({ path: moduleYamlPath(definitionId, vNum, mod.id), content: stringifyYAML(buildModuleYamlObject(mod)) })),
  ]

  await client.writeFiles(files, { branch, message: `Save definition "${definitionId}" v${vNum}`, deletePaths })
  const fresh = await loadGitHubDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

/** Publishes a draft version — one commit, flipping `definition.yaml`'s own `status` field to `published` after the same structural validation `writeGitHubDefinitionVersion` runs. Mirrors `lib/definitionAzureDevOps.js`'s `publishAzureDevOpsDefinitionVersion`. */
export async function publishGitHubDefinitionVersion(definitionId, version, options) {
  const { client, branch } = clientFor(options)
  const vNum = assertValidVersion(version, definitionId)
  const raw = await readYamlFile(client, definitionYamlPath(definitionId, vNum), branch)
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }

  const stages = (raw.stages ?? []).map(stageFromRaw)
  const artefacts = (raw.artefacts ?? []).map(artefactFromRaw)
  const moduleEntries = await client.listFolder(`${definitionDirPath(definitionId, vNum)}/modules`, { branch })
  const modules = []
  for (const entry of moduleEntries.filter((e) => !e.isFolder && e.path.endsWith('.yaml'))) {
    const rawModule = await readYamlFile(client, entry.path, branch)
    modules.push(moduleFromRaw(rawModule))
  }
  const problems = findDefinitionProblemsInStructure({ stages, artefacts, modules })
  if (problems.length > 0) {
    return { problems }
  }

  const newObj = buildDefinitionYamlObject(definitionId, vNum, 'published', raw, raw)
  await client.writeFiles([{ path: definitionYamlPath(definitionId, vNum), content: stringifyYAML(newObj) }], {
    branch,
    message: `Publish definition "${definitionId}" v${vNum}`,
  })
  const fresh = await loadGitHubDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

export async function archiveGitHubDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (!(await fileExists(client, archivedMarkerPath(definitionId), branch))) {
    await client.writeFiles([{ path: archivedMarkerPath(definitionId), content: '' }], { branch, message: `Archive definition "${definitionId}"` })
  }
  return { id: definitionId, archived: true }
}

export async function restoreGitHubDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (await fileExists(client, archivedMarkerPath(definitionId), branch)) {
    await client.deleteFile(archivedMarkerPath(definitionId), { branch, message: `Restore definition "${definitionId}"` })
  }
  return { id: definitionId, archived: false }
}
