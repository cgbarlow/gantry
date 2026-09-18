import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { AzureDevOpsNotFoundError } from './azureDevOpsClient.js'
import { resolveContentStore } from './providerRegistry.js'
import { isValidSlug } from './slug.js'
import {
  buildDefinitionYamlObject,
  buildModuleYamlObject,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
} from './definition.js'

/**
 * WI #383 (ADR-0036) — the Azure-DevOps-backed half of "a workspace can hold its own definitions".
 *
 * `lib/definitionHome.js`/`lib/definition.js` cover the server library and a server workspace's own
 * `definitions/` folder, both plain local filesystem the existing, already-parametrized
 * `lib/definition.js` functions read and write directly. An Azure DevOps workspace's `definitions/`
 * folder lives in that workspace's own repo instead — reached over the network, with the caller's own
 * PAT, exactly like `lib/instance.js`'s Azure-DevOps-backed instance-data functions — so it needs its
 * own read/write path rather than a `definitionsDir` string `existsSync`/`readFileSync` can point at.
 *
 * Same on-disk layout as the local library (`definitions/<id>/<n>/definition.yaml` +
 * `definitions/<id>/<n>/modules/<moduleId>.yaml`, an optional `CHANGELOG.md`, and an
 * `definitions/<id>/.archived` marker), same draft/published integer-version lifecycle and
 * published-immutability rule — reusing `buildDefinitionYamlObject`/`buildModuleYamlObject`/
 * `findDefinitionProblemsInStructure`/`definitionVersionProjection` from `lib/definition.js` so the
 * YAML shape and validation rules can never drift between the two homes. What differs is purely
 * *where* the bytes land: every write below is exactly one `client.writeFiles` call — one Azure
 * DevOps push, one commit, straight to the workspace repo's `main` (ADR-0036: "not via stage branches
 * or PRs") — never a stage branch, never a pull request, unlike instance data's own per-stage-branch
 * lifecycle (ADR-0014). A workspace definition has no review gate of its own to preserve; the
 * workspace repo is the author's own space (ADR-0036's "no shadowing" / "a workspace is a boundary"
 * reasoning applies to *readability*, not to how a save inside one is committed).
 *
 * Deliberately a smaller surface than `lib/definition.js`'s: templates/reference-docx and
 * clone-from-another-definition are not implemented here yet (an author can still bring content in via
 * WI #382's copy-with-provenance flow, which only ever needs the *destination* definitionsDir to be
 * writable, already true here). See this ticket's own final report for the full list of what phase 3
 * left for a later phase.
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

/** Builds the Azure DevOps client + target branch from `options.azureDevOps`, the same `{ organization, project, repository, pat, baseUrl?, branch? }` shape `lib/instance.js`'s own `azureDevOpsClientFor` accepts — kept as a private duplicate rather than an import so this module has no dependency on `lib/instance.js`'s instance-data-specific path helpers. */
function clientFor(options) {
  const { organization, project, repository, pat, baseUrl, branch } = options.azureDevOps
  return { client: resolveContentStore('azure-devops', { organization, project, repository, pat, baseUrl }), branch }
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
    if (err instanceof AzureDevOpsNotFoundError) return false
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

export async function isAzureDevOpsDefinitionArchived(definitionId, options) {
  const { client, branch } = clientFor(options)
  return fileExists(client, archivedMarkerPath(definitionId), branch)
}

/** Every definition id with at least one version directory, in a workspace's Azure DevOps repo. */
export async function listAzureDevOpsDefinitionIds(options) {
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

// A raw YAML module (`{ id, title, purpose, fields: [{ id, title, type, required, 'required-at', guidance, 'copied-from' }] }`)
// into the camelCase shape `findDefinitionProblemsInStructure`/`definitionVersionProjection` expect — the
// same mapping `lib/definition.js`'s own (private) `loadModuleSpec` does for the local-filesystem path.
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
 * Loads one version of an Azure DevOps workspace definition — the same `{ id, title, description,
 * version, status, stages, artefacts, modules }` shape `lib/definition.js`'s `loadDefinition` returns
 * (`modules` a Map, `stages`/`artefacts` referencing module ids by string), so `definitionVersionProjection`
 * works on it unchanged. Only the modules a stage or artefact actually references are loaded (mirroring
 * `loadDefinition`'s own referenced-only behaviour, not every file under `modules/`), and a reference
 * that doesn't resolve throws a plain, readable error rather than running the full disk-based
 * `findDefinitionProblems` pass `loadDefinition` does — this path is network-bound, so it trades that
 * exhaustive "report every problem" diagnostic for one round trip per referenced module instead of a
 * full structural scan on every read; `writeAzureDevOpsDefinitionVersion`/`publishAzureDevOpsDefinitionVersion`
 * below still run the full `findDefinitionProblemsInStructure` check before anything is written.
 */
export async function loadAzureDevOpsDefinition(definitionId, version, options) {
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
      if (err instanceof AzureDevOpsNotFoundError) {
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
 * Every definition available in a workspace's Azure DevOps repo, in the same row shape
 * `lib/definition.js`'s `listDefinitions` produces (id/title/description/stages/latestPublished/versions),
 * so a caller can tag these `home: { kind: 'azure-devops-workspace', id, name }` and concatenate them
 * onto `lib/definitionHome.js`'s local-only `listDefinitionsAcrossHomes` result exactly the way that
 * module already concatenates server-workspace rows onto the library's.
 */
export async function listAzureDevOpsDefinitions(options, { includeArchived = false } = {}) {
  const { client, branch } = clientFor(options)
  const ids = await listAzureDevOpsDefinitionIds(options)
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
    const definition = await loadAzureDevOpsDefinition(id, versionToLoad, options)
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

/** A brand-new, empty draft (v1) definition in a workspace's Azure DevOps repo — one commit. Mirrors `lib/definition.js`'s `createBlankDefinition`. */
export async function createBlankAzureDevOpsDefinition(newId, options, { title } = {}) {
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

/** A new draft version, copied from the definition's current latest version — one commit. Mirrors `lib/definition.js`'s `createDraftVersion`, including its "carry the on-disk YAML forward verbatim" approach (module file content is copied byte-for-byte, not re-serialized). */
export async function createAzureDevOpsDraftVersion(definitionId, options) {
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

/** Saves a draft version's structure — one commit, adding/editing every changed file and deleting any module file the new structure no longer wants, exactly like `lib/definition.js`'s `writeDefinitionVersion`'s validate-then-write, just against a repo instead of a temp directory. */
export async function writeAzureDevOpsDefinitionVersion(definitionId, version, structure, options) {
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
  const fresh = await loadAzureDevOpsDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

/** Publishes a draft version — one commit, flipping `definition.yaml`'s own `status` field to `published` after the same structural validation `writeAzureDevOpsDefinitionVersion`/`lib/definition.js`'s `publishDefinitionVersion` run. Mirrors that function's "load every module the definition currently references, validate the whole structure, then write" shape. */
export async function publishAzureDevOpsDefinitionVersion(definitionId, version, options) {
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
  const fresh = await loadAzureDevOpsDefinition(definitionId, vNum, options)
  return definitionVersionProjection(fresh)
}

export async function archiveAzureDevOpsDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (!(await fileExists(client, archivedMarkerPath(definitionId), branch))) {
    await client.writeFiles([{ path: archivedMarkerPath(definitionId), content: '' }], { branch, message: `Archive definition "${definitionId}"` })
  }
  return { id: definitionId, archived: true }
}

export async function restoreAzureDevOpsDefinition(definitionId, options) {
  const { client, branch } = clientFor(options)
  if (await fileExists(client, archivedMarkerPath(definitionId), branch)) {
    await client.deleteFile(archivedMarkerPath(definitionId), { branch, message: `Restore definition "${definitionId}"` })
  }
  return { id: definitionId, archived: false }
}
