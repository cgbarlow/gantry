import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDefinition,
  listDefinitions,
  loadDefinitionChangelog,
  readDefinitionTemplate,
  writeDefinitionTemplate,
  readDefinitionReferenceDocx,
  writeDefinitionReferenceDocx,
  readDefinitionLogo,
  writeDefinitionLogo,
  createBlankDefinition,
  createDraftVersion,
  cloneDefinition,
  writeDefinitionVersion,
  publishDefinitionVersion,
  archiveDefinition,
  restoreDefinition,
  isDefinitionArchived,
  listVersionNumbers,
} from './definition.js'
import { copyFolderToDirectory, folderHasFiles, listChildren, syncDirectoryToFolder } from './storageFiles.js'
import { forgetReferenceDocLogos } from './instanceLogo.js'

/**
 * A server workspace's Definitions, kept in a store instead of on the server's disk (ADR-0070, #265). A workspace's `definitions/` folder is laid out exactly as `lib/definition.js` lays out the library's (`<id>/<n>/definition.yaml`, `modules/`, `templates/`, `CHANGELOG.md`, an `<id>/.archived` marker), and that module already does all the reading, checking and writing over a plain directory. So rather than a second implementation that could drift, these functions copy what is needed from the store to a scratch directory, run the existing function there, and, for a write, make the store's folder match the scratch copy afterwards. Reads persist nothing. A write that throws changes nothing in the store.
 *
 * `workspaceDefinitionsDir` is the store key of the workspace's `definitions/` folder (`<workspace>/definitions`); every path is a plain string the store understands.
 */

const SCRATCH_PREFIX = 'gantry-definitions-'

const folderKey = (workspaceDefinitionsDir, id) => `${workspaceDefinitionsDir.replace(/\/$/, '')}/${id}`

async function newScratch() {
  const scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX))
  const definitionsDir = join(scratch, 'definitions')
  await mkdir(definitionsDir, { recursive: true })
  return { scratch, definitionsDir }
}

async function removeScratch(scratch) {
  forgetReferenceDocLogos(scratch)
  await rm(scratch, { recursive: true, force: true })
}

const exists = (path) => access(path).then(() => true, () => false)

async function stage(storage, workspaceDefinitionsDir, definitionsDir, ids, templates) {
  const wanted = ids ?? (await listChildren(storage, workspaceDefinitionsDir)).folders
  for (const id of wanted) {
    const idDir = join(definitionsDir, id)
    await copyFolderToDirectory(storage, folderKey(workspaceDefinitionsDir, id), idDir, {
      filter: templates ? undefined : (rel) => rel !== 'templates' && !rel.startsWith('templates/') && !rel.includes('/templates/'),
    })
    // A store has no empty folders, but a Definition with no modules yet still has a `modules/` folder as far as lib/definition.js is concerned.
    const versionDirs = (await exists(idDir)) ? (await readdir(idDir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[1-9]\d*$/.test(e.name)).map((e) => join(idDir, e.name)) : []
    for (const versionDir of [idDir, ...versionDirs]) {
      if (await exists(join(versionDir, 'definition.yaml'))) await mkdir(join(versionDir, 'modules'), { recursive: true })
    }
  }
  return wanted
}

/**
 * Runs `fn(definitionsDir)` against a scratch copy of the workspace's Definitions, then removes the copy. `options.ids` limits which Definitions are copied (default: all); `options.templates: false` leaves out `templates/` (loading a Definition does not need them).
 */
export async function readWorkspaceDefinitions(storage, workspaceDefinitionsDir, fn, { ids = null, templates = true } = {}) {
  const { scratch, definitionsDir } = await newScratch()
  try {
    await stage(storage, workspaceDefinitionsDir, definitionsDir, ids, templates)
    return await fn(definitionsDir)
  } finally {
    await removeScratch(scratch)
  }
}

/**
 * Like `readWorkspaceDefinitions`, but afterwards the store's folders for every Definition touched (`options.ids`, plus any new one `fn` created) are made to match the scratch copy: changed files written, removed files deleted. Nothing is written when `fn` throws.
 */
export async function writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, fn, { ids = null } = {}) {
  const { scratch, definitionsDir } = await newScratch()
  try {
    const staged = await stage(storage, workspaceDefinitionsDir, definitionsDir, ids, true)
    const result = await fn(definitionsDir)
    const now = (await readdir(definitionsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const id of new Set([...staged, ...now])) {
      await syncDirectoryToFolder(storage, folderKey(workspaceDefinitionsDir, id), join(definitionsDir, id))
    }
    return result
  } finally {
    await removeScratch(scratch)
  }
}

/** Whether the workspace's `definitions/` folder holds the Definition `id`. */
export async function definitionExistsInStorage(storage, workspaceDefinitionsDir, id) {
  return folderHasFiles(storage, folderKey(workspaceDefinitionsDir, id))
}

/**
 * A Definition loaded for use by an Instance, `{ definition, dispose }`. A server workspace's own Definition (`options.workspaceDefinitionsDir` in `options.storage`) wins; otherwise the library one on the server's disk (`options.definitionsDir`), as `definitionsDirForScope` does for a disk workspace. A Definition from the store is copied to a scratch directory, so its `definitionDir` points there: call `dispose()` when done with it. `options.templates: true` copies the Definition's templates and reference documents too, which a render needs.
 */
export async function openDefinition(definitionId, options = {}) {
  const { storage, workspaceDefinitionsDir, definitionsDir, version, templates = false } = options
  if (storage && workspaceDefinitionsDir && (await definitionExistsInStorage(storage, workspaceDefinitionsDir, definitionId))) {
    const { scratch, definitionsDir: scratchDefinitionsDir } = await newScratch()
    try {
      await stage(storage, workspaceDefinitionsDir, scratchDefinitionsDir, [definitionId], templates)
      const definition = loadDefinition(definitionId, { definitionsDir: scratchDefinitionsDir, version })
      return { definition, dispose: () => removeScratch(scratch) }
    } catch (err) {
      await removeScratch(scratch)
      throw err
    }
  }
  return { definition: loadDefinition(definitionId, { definitionsDir, version }), dispose: async () => {} }
}

// --- reads ---

/** `listDefinitions` over the workspace's Definitions. */
export function listDefinitionsInStorage(storage, workspaceDefinitionsDir, { includeArchived = false } = {}) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => listDefinitions({ definitionsDir, includeArchived }), { templates: false })
}

export function listDefinitionVersionsInStorage(storage, workspaceDefinitionsDir, id) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => listVersionNumbers(id, definitionsDir), { ids: [id], templates: false })
}

export function isDefinitionArchivedInStorage(storage, workspaceDefinitionsDir, id) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => isDefinitionArchived(id, { definitionsDir }), { ids: [id], templates: false })
}

export function loadDefinitionChangelogFromStorage(storage, workspaceDefinitionsDir, id, version) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => loadDefinitionChangelog(id, version, { definitionsDir }), { ids: [id], templates: false })
}

export function readDefinitionTemplateFromStorage(storage, workspaceDefinitionsDir, id, version, name) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => readDefinitionTemplate(id, version, name, { definitionsDir }), { ids: [id] })
}

export function readDefinitionReferenceDocxFromStorage(storage, workspaceDefinitionsDir, id, version, artefactId) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => readDefinitionReferenceDocx(id, version, artefactId, { definitionsDir }), { ids: [id] })
}

export function readDefinitionLogoFromStorage(storage, workspaceDefinitionsDir, id, version) {
  return readWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => readDefinitionLogo(id, version, { definitionsDir }), { ids: [id] })
}

// --- writes ---

export function createBlankDefinitionInStorage(storage, workspaceDefinitionsDir, newId, { title } = {}) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => createBlankDefinition(newId, { definitionsDir, title }), { ids: [newId] })
}

export function createDraftVersionInStorage(storage, workspaceDefinitionsDir, id) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => createDraftVersion(id, { definitionsDir }), { ids: [id] })
}

export function cloneDefinitionInStorage(storage, workspaceDefinitionsDir, sourceId, newId) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => cloneDefinition(sourceId, newId, { definitionsDir }), { ids: [sourceId, newId] })
}

export function writeDefinitionVersionToStorage(storage, workspaceDefinitionsDir, id, version, structure) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => writeDefinitionVersion(id, version, structure, { definitionsDir }), { ids: [id] })
}

export function publishDefinitionVersionInStorage(storage, workspaceDefinitionsDir, id, version) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => publishDefinitionVersion(id, version, { definitionsDir }), { ids: [id] })
}

export function archiveDefinitionInStorage(storage, workspaceDefinitionsDir, id) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => archiveDefinition(id, { definitionsDir }), { ids: [id] })
}

export function restoreDefinitionInStorage(storage, workspaceDefinitionsDir, id) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => restoreDefinition(id, { definitionsDir }), { ids: [id] })
}

export function writeDefinitionTemplateToStorage(storage, workspaceDefinitionsDir, id, version, name, source) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => writeDefinitionTemplate(id, version, name, source, { definitionsDir }), { ids: [id] })
}

export function writeDefinitionReferenceDocxToStorage(storage, workspaceDefinitionsDir, id, version, artefactId, buffer) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => writeDefinitionReferenceDocx(id, version, artefactId, buffer, { definitionsDir }), { ids: [id] })
}

export function writeDefinitionLogoToStorage(storage, workspaceDefinitionsDir, id, version, image) {
  return writeWorkspaceDefinitions(storage, workspaceDefinitionsDir, (definitionsDir) => writeDefinitionLogo(id, version, image, { definitionsDir }), { ids: [id] })
}
