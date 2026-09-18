import { parse as parseYAML } from 'yaml'
import { createGitHubClient, GitHubNotFoundError } from './gitHubClient.js'

/**
 * #19 (ADR-0037, ADR-0039) — the GitHub-backed half of reading a **library repo**'s `definitions/`
 * folder, mirroring `lib/definitionAzureDevOps.js`'s read path (`listAzureDevOpsDefinitions`/
 * `loadAzureDevOpsDefinition`) but over `lib/gitHubClient.js` instead. Deliberately **read-only** —
 * a library repo is a read source only (ADR-0036), so unlike `lib/definitionAzureDevOps.js` (which
 * also writes for a GitHub *workspace*'s own definitions, a later ticket's job — #17), this module
 * has no create/write/publish/archive counterparts.
 *
 * Same on-disk-shape assumption as the Azure DevOps path: `definitions/<id>/<n>/definition.yaml` +
 * `definitions/<id>/<n>/modules/<moduleId>.yaml`, an optional `definitions/<id>/.archived` marker,
 * draft/published version status carried in each `definition.yaml`. Reuses `lib/libraryCache.js`'s
 * caller contract exactly: `lib/libraryCache.js`'s `refreshLibraryRepo` calls
 * `listGitHubDefinitions` then `loadGitHubDefinition` per published id, the same two-call shape it
 * already uses for an Azure DevOps library repo.
 *
 * Deliberately duplicates rather than shares `lib/definitionAzureDevOps.js`'s private per-provider
 * helpers (path-building, YAML parsing, module-shape mapping) — the two clients' method shapes
 * (`getFileContent`/`listFolder`) already match closely enough that a shared read helper is a
 * reasonable follow-up once GitHub's content store is complete (#11), but factoring it now, against
 * only a read-only partial implementation, risks designing that seam against the wrong shape.
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

// A raw YAML module into the camelCase shape `findDefinitionProblemsInStructure`/
// `definitionVersionProjection` expect — identical mapping to `lib/definitionAzureDevOps.js`'s own
// private `mapRawModule` (the YAML shape is provider-independent; only how the bytes are fetched differs).
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
      if (err instanceof GitHubNotFoundError) {
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
