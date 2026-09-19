import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { createBitbucketClient, BitbucketNotFoundError } from './bitbucketClient.js'
import { isValidSlug } from './slug.js'
import {
  buildDefinitionYamlObject,
  buildModuleYamlObject,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
} from './definition.js'

/**
 * #43 (ADR-0037, ADR-0039, ADR-0042) — the Bitbucket-backed half of reading and writing a
 * `definitions/` folder, mirroring `lib/definitionGitLab.js`'s own read/write path but over
 * `lib/bitbucketClient.js` instead. Serves the same two callers as every other provider's own
 * definition module: `lib/libraryCache.js` (read-only — a **library repo** is a read source only,
 * ADR-0036, so it never calls the write functions below, and per ADR-0042 needs only the workspace's
 * Bitbucket credential — a library repo never touches Jira) and, potentially, `lib/server.js`'s
 * `/api/workspaces/:id/definitions*` routes for an Atlassian **workspace**'s own `definitions/` folder
 * — one commit per create/save/publish/archive/restore, straight to `main`, never a stage branch or PR
 * (a workspace definition has no review gate of its own to preserve — see
 * `lib/definitionAzureDevOps.js`'s own doc comment for the full reasoning, identical here). Wiring the
 * latter route into `lib/server.js` is left to the ticket that actually needs it (mirroring GitLab's
 * own separate #32) — this module is written to the same full shape as `lib/definitionGitLab.js` so
 * that wiring is a mechanical follow-up, not a redesign.
 *
 * Same on-disk-shape assumption as every other provider's definition module:
 * `definitions/<id>/<n>/definition.yaml` + `definitions/<id>/<n>/modules/<moduleId>.yaml`, an optional
 * `definitions/<id>/.archived` marker, draft/published version status carried in each
 * `definition.yaml`. Reuses `lib/libraryCache.js`'s caller contract exactly: `refreshLibraryRepo` would
 * call `listAtlassianDefinitions` then `loadAtlassianDefinition` per published id, the same two-call
 * shape it already uses for the other three providers.
 *
 * Only ever talks to Bitbucket — never Jira. ADR-0042: a `definitions/` folder is content-store data,
 * and a Library repo (which never touches work items at all) needs only its Bitbucket credential; a
 * workspace's own `definitions/` folder is exactly the same shape of data, so the same is true there.
 * `options.atlassian` is therefore the *Bitbucket* half of an Atlassian location — `{ owner,
 * repository, pat, branch? }` — never `{ bitbucket, jira }`; a caller that already resolved the
 * workspace's two-token credential pair passes only the Bitbucket token through here.
 *
 * Deliberately duplicates rather than shares `lib/definitionGitHub.js`/`lib/definitionGitLab.js`'s
 * private per-provider helpers (path-building, YAML parsing, module-shape mapping) — same reasoning
 * those modules' own doc comments give: the four clients' method shapes (`getFileContent`/
 * `listFolder`/`writeFiles`/`deleteFile`) already match closely enough that a shared helper is a
 * reasonable follow-up, but factoring it now risks designing that seam against the wrong shape.
 *
 * Deliberately a smaller surface than `lib/definitionGitHub.js`'s: templates/reference-docx and
 * clone-from-another-definition are not implemented here either, matching every other provider
 * module's own scope.
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

/** Builds the Bitbucket client + target branch from `options.atlassian`, the `{ owner, repository, pat, baseUrl?, branch? }` shape — mirrors `lib/definitionGitLab.js`'s private `clientFor`. */
function clientFor(options) {
  const { owner, repository, pat, baseUrl, branch } = options.atlassian
  return { client: createBitbucketClient({ owner, repository, pat, baseUrl }), branch }
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
    if (err instanceof BitbucketNotFoundError) return false
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

export async function isAtlassianDefinitionArchived(definitionId, options) {
  const { client, branch } = clientFor(options)
  return fileExists(client, archivedMarkerPath(definitionId), branch)
}

/** Every definition id with at least one version directory, in a Bitbucket library repo. */
export async function listAtlassianDefinitionIds(options) {
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

// A raw YAML module into the camelCase shape `findDefinitionProblemsInStructure`/
// `definitionVersionProjection` expect — identical mapping to every other provider's own private
// `mapRawModule` (the YAML shape is provider-independent; only how the bytes are fetched differs).
function mapRawModule(raw) {
  return {
    id: raw.id,
    title: raw.title,
    purpose: raw.purpose,
    copiedFrom: raw['copied-from'],
    fields: (raw.fields ?? []).map((field) => ({
      id: field.id,
      title: field.title,
      type: field.type,
      required: field.required,
      requiredAt: field['required-at'],
      guidance: field.guidance,
      copiedFrom: field['copied-from'],
    })),
  }
}

/**
 * Loads one version of a Bitbucket library repo's definition — the same `{ id, title, description,
 * version, status, stages, artefacts, modules }` shape every other provider's own `load*Definition`
 * returns, so `lib/libraryCache.js`'s `refreshLibraryRepo` can treat all four providers identically
 * once it has this result. Only the modules a stage or artefact actually references are loaded,
 * mirroring that function's own referenced-only behaviour.
 */
export async function loadAtlassianDefinition(definitionId, version, options) {
  const { client, branch } = clientFor(options)
  const vNum = assertValidVersion(version, definitionId)
  const raw = await readYamlFile(client, definitionYamlPath(definitionId, vNum), branch)

  const stages = (raw.stages ?? []).map((stage) => ({
    id: stage.id,
    title: stage.title,
    purpose: stage.purpose,
    gate: stage.gate,
    modules: stage.modules ?? [],
    example: stage.example,
    copiedFrom: stage['copied-from'],
  }))
  const artefacts = (raw.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    title: artefact.title,
    purpose: artefact.purpose,
    template: artefact.template,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
    copiedFrom: artefact['copied-from'],
  }))

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
      if (err instanceof BitbucketNotFoundError) {
        throw new Error(`Definition "${definitionId}" references module "${moduleId}", which does not exist at version ${vNum}`)
      }
      throw err
    }
    modules.set(moduleId, mapRawModule(rawModule))
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
 * Every definition available in a Bitbucket library repo, in the same row shape every other
 * provider's own `list*Definitions` produces — so `lib/libraryCache.js`'s `refreshLibraryRepo` can
 * treat every provider's rows identically.
 */
export async function listAtlassianDefinitions(options, { includeArchived = false } = {}) {
  const { client, branch } = clientFor(options)
  const ids = await listAtlassianDefinitionIds(options)
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
    const definition = await loadAtlassianDefinition(id, versionToLoad, options)
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

/** A brand-new, empty draft (v1) definition in an Atlassian workspace's repo — one commit. Mirrors `lib/definitionGitLab.js`'s `createBlankGitLabDefinition`. */
export async function createBlankAtlassianDefinition(newId, options, { title } = {}) {
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

/** A new draft version, copied from the definition's current latest version — one commit. Mirrors `lib/definitionGitLab.js`'s `createGitLabDraftVersion`, including its "carry the on-disk YAML forward verbatim" approach. */
export async function createAtlassianDraftVersion(definitionId, options) {
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

/** Saves a draft version's structure — one commit, adding/editing every changed file and deleting any module file the new structure no longer wants. Mirrors `lib/definitionGitLab.js`'s `writeGitLabDefinitionVersion`. */
export async function writeAtlassianDefinitionVersion(definitionId, version, structure, options) {
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
  const fresh = await loadAtlassianDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

/** Publishes a draft version — one commit, flipping `definition.yaml`'s own `status` field to `published` after the same structural validation `writeAtlassianDefinitionVersion` runs. Mirrors `lib/definitionGitLab.js`'s `publishGitLabDefinitionVersion`. */
export async function publishAtlassianDefinitionVersion(definitionId, version, options) {
  const { client, branch } = clientFor(options)
  const vNum = assertValidVersion(version, definitionId)
  const raw = await readYamlFile(client, definitionYamlPath(definitionId, vNum), branch)
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }

  const stages = (raw.stages ?? []).map((s) => ({ id: s.id, modules: s.modules ?? [] }))
  const artefacts = (raw.artefacts ?? []).map((a) => ({ id: a.id, requires: a.requires ?? [] }))
  const moduleEntries = await client.listFolder(`${definitionDirPath(definitionId, vNum)}/modules`, { branch })
  const modules = []
  for (const entry of moduleEntries.filter((e) => !e.isFolder && e.path.endsWith('.yaml'))) {
    const rawModule = await readYamlFile(client, entry.path, branch)
    modules.push(mapRawModule(rawModule))
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
  const fresh = await loadAtlassianDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

export async function archiveAtlassianDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (!(await fileExists(client, archivedMarkerPath(definitionId), branch))) {
    await client.writeFiles([{ path: archivedMarkerPath(definitionId), content: '' }], { branch, message: `Archive definition "${definitionId}"` })
  }
  return { id: definitionId, archived: true }
}

export async function restoreAtlassianDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (await fileExists(client, archivedMarkerPath(definitionId), branch)) {
    await client.deleteFile(archivedMarkerPath(definitionId), { branch, message: `Restore definition "${definitionId}"` })
  }
  return { id: definitionId, archived: false }
}
