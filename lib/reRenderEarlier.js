import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { artefactModuleIds } from './definition.js'
import { instanceDisplayName, filenamePatternContext, RENDER_MANIFEST_FILENAME, parseRenderManifest, AZURE_DEVOPS_WORKSPACE_ROOT } from './instance.js'
import { resolveContentStore } from './providerRegistry.js'
import { NotFoundError } from './providerErrors.js'
import {
  remoteProvider,
  findChangedSinceApproval,
  findChangedSinceApprovalSafely,
  printedFieldsOfArtefact,
  comparableValue,
  currentModuleFields,
  approvedModuleFields,
} from './changedSinceApproval.js'

// Re-rendering is required before re-approval, and earlier approved documents are kept (#276,
// docs/adr/0069). When a later stage changes a Field an earlier approved stage's Artefacts print
// (lib/changedSinceApproval.js says which), the later stage's approval re-approves that earlier stage,
// so the documents on `main` have to be re-rendered on the later stage's branch first. Three parts:
//
//   1. Request approval refuses until each affected earlier Artefact is re-rendered there
//      (`assertEarlierArtefactsReRendered`, called by lib/stageApproval.js).
//   2. The refusal carries what to re-render, and `reRenderEarlierArtefact` does it: it keeps the
//      approved copy under `out/approved/<name> — approved <date>.docx`, renders the Artefact onto the
//      later stage's branch under its usual name, and records what the render was made from.
//   3. The usual name therefore always means the currently approved version.
//
// "Re-rendered" is decided by a record rather than by looking inside the Word file: for each Artefact the
// record keeps a fingerprint of the Fields the Artefact prints, as they were on the branch when the
// re-render was made. If a Field changes afterwards the fingerprint no longer matches and the Artefact
// has to be re-rendered again, which is also what a person would expect.

export const APPROVED_DIRECTORY = 'out/approved'
export const REAPPROVAL_RECORD_FILENAME = '.gantry-reapproval.json'

/** Request approval's refusal, carrying the Artefacts still to re-render (`artefacts`) for the caller to offer. */
export class ReRenderRequiredError extends Error {
  constructor(message, artefacts) {
    super(message)
    this.name = 'ReRenderRequiredError'
    this.artefacts = artefacts
  }
}

function fieldCountLabel(count) {
  return `${count} ${count === 1 ? 'Field' : 'Fields'}`
}

// A repo-relative directory for one Instance's rendered output, derived from a usual out path.
function outDirectoryOf(path) {
  return path.slice(0, path.lastIndexOf('/'))
}

function baseNameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The name the approved copy of a document is kept under: its usual name with the approval date before the
 * extension, `Atlas - SOAP — approved 2026-10-12.docx`. A Provider that cannot say when the approval was
 * merged names it by Pull Request instead, so two approvals never share a name.
 */
export function approvedCopyFilename(usualFilename, { approvedOn, pullRequestId }) {
  const dot = usualFilename.lastIndexOf('.')
  const stem = dot === -1 ? usualFilename : usualFilename.slice(0, dot)
  const extension = dot === -1 ? '' : usualFilename.slice(dot)
  return `${stem} — approved ${approvedOn ?? `in Pull Request ${pullRequestId}`}${extension}`
}

// A store that reads and writes the live state of a branch: the shared read cache is for reads of an
// unchanged ref, and these reads follow writes made moments earlier.
function freshStore(provider, base, branch) {
  const { sharedCache: _sharedCache, ...uncached } = base
  return resolveContentStore(provider.contentStoreId, { ...uncached, branch })
}

async function readRecord(store, recordPath, branch) {
  try {
    return parseRenderManifest(await store.getFileContent(recordPath, { branch }))
  } catch (err) {
    if (err instanceof NotFoundError) return {}
    throw err
  }
}

// The Fields an Artefact prints, as they are on `branch` right now, reduced to one comparable string.
async function fingerprintOf(definition, provider, base, slug, branch, artefact) {
  const printed = printedFieldsOfArtefact(definition, artefact)
  const entries = []
  for (const [moduleId, fieldIds] of printed) {
    const fields = await currentModuleFields(definition, provider, base, slug, branch, moduleId)
    for (const field of definition.modules.get(moduleId).fields) {
      if (fieldIds.has(field.id)) entries.push([`${moduleId}.${field.id}`, comparableValue(fields?.[field.id])])
    }
  }
  return createHash('sha256').update(JSON.stringify([artefact.id, entries])).digest('hex')
}

// Where the Artefact's rendered Word document goes on `branch` under its usual name: the Instance's name and
// the Artefact's title, or its `filename:` pattern resolved against the Fields as they are there.
async function usualPathOf(definition, provider, base, slug, branch, instance, artefact) {
  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    // eslint-disable-next-line no-await-in-loop
    modules[moduleId] = (await currentModuleFields(definition, provider, base, slug, branch, moduleId)) ?? {}
  }
  return provider.outPath(slug, instanceDisplayName(instance), artefact.title, 'docx', filenamePatternContext(artefact, modules, slug))
}

// The flagged earlier stages' Artefacts that print at least one of the changed Fields, with those Fields.
function affectedArtefacts(definition, flagged) {
  const affected = []
  for (const entry of flagged) {
    const stage = definition.stages.find((s) => s.id === entry.stageId)
    if (!stage) continue
    for (const artefact of definition.artefacts.filter((a) => a.gate === stage.gate)) {
      // An Artefact with no template can't be rendered, so it can't be asked to be.
      if (definition.definitionDir && !existsSync(join(definition.definitionDir, artefact.template))) continue
      const printed = printedFieldsOfArtefact(definition, artefact)
      const fields = entry.fields.filter((ref) => {
        const [moduleId, fieldId] = ref.split('.')
        return printed.get(moduleId)?.has(fieldId)
      })
      if (fields.length > 0) affected.push({ entry, stage, artefact, fields })
    }
  }
  return affected
}

/**
 * The earlier-stage Artefacts a Request approval for the current stage must have re-rendered first and
 * has not: `[{ stageId, stageTitle, artefactId, artefactTitle, fields, count }]`, in stage order. Empty
 * when nothing is flagged, or each affected Artefact was re-rendered from the Fields as they are now.
 *
 * - `providerKey`: `'azureDevOps'`, `'github'` or `'gitlab'`; any other provider has no flag and so none here.
 * - `base`: that provider's credentialed location, without a branch.
 * - `branch`: the current stage's branch, where the re-renders live.
 * - `flagged`: `findChangedSinceApproval`'s answer for this Instance, when the caller already has it.
 */
export async function findArtefactsNeedingReRender({ providerKey, base, slug, definition, instance, branch, flagged }) {
  const provider = remoteProvider(providerKey)
  if (!provider) return []
  const changed = flagged ?? (await findChangedSinceApprovalSafely({ providerKey, base, slug, definition, instance, currentBranch: branch }))
  const affected = affectedArtefacts(definition, changed)
  if (affected.length === 0) return []

  const store = freshStore(provider, base, branch)
  const recordPath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/out/approved/${REAPPROVAL_RECORD_FILENAME}`
  const record = await readRecord(store, recordPath, branch)

  const needing = []
  for (const { entry, stage, artefact, fields } of affected) {
    const recorded = record[artefact.id]
    // eslint-disable-next-line no-await-in-loop
    const current = await fingerprintOf(definition, provider, base, slug, branch, artefact)
    if (recorded?.fingerprint === current && recorded?.stage === entry.stageId) continue
    // A stage can be approved without every one of its Artefacts having been rendered (only the ones that
    // pass its gate must be). One with no approved document has nothing for a re-render to replace.
    // eslint-disable-next-line no-await-in-loop
    const usualPath = await usualPathOf(definition, provider, base, slug, branch, instance, artefact)
    // eslint-disable-next-line no-await-in-loop
    if (!(await approvedDocument({ provider, base, slug, definition, artefact, entry, instanceName: instanceDisplayName(instance), usualPath }))) continue
    needing.push({
      stageId: stage.id,
      stageTitle: stage.title,
      artefactId: artefact.id,
      artefactTitle: artefact.title,
      fields,
      count: fields.length,
    })
  }
  return needing
}

/** Throws `ReRenderRequiredError` when `findArtefactsNeedingReRender` finds anything. */
export async function assertEarlierArtefactsReRendered(args) {
  const needing = await findArtefactsNeedingReRender(args)
  if (needing.length === 0) return
  const { definition, instance } = args
  const currentStage = definition.stages.find((s) => s.id === instance.stage)
  const list = needing
    .map((item) => `"${item.artefactTitle}" (${item.stageTitle}, ${fieldCountLabel(item.count)} changed)`)
    .join(', ')
  throw new ReRenderRequiredError(
    `Cannot request approval: this stage's approval also re-approves ${[...new Set(needing.map((item) => item.stageTitle))].join(', ')}, ` +
      `so ${needing.length === 1 ? 'its document' : 'their documents'} must be re-rendered on the "${currentStage?.title ?? instance.stage}" branch first: ${list}. ` +
      'Render each earlier document onto this stage from the Request approval panel, or with the rerender_earlier_artefact tool, then request approval again.',
    needing
  )
}

// The bytes of the document as approved, and the name it carried then, or `null` when nothing was kept
// at the approval commit (a stage can be approved without a document having been rendered for it).
async function approvedDocument({ provider, base, slug, definition, artefact, entry, instanceName, usualPath }) {
  const { sharedCache: _sharedCache, branch: _branch, ...uncached } = base
  const store = resolveContentStore(provider.contentStoreId, uncached)
  const outDir = outDirectoryOf(usualPath)

  // The render manifest at the approval commit says what the document was called then, which matters when
  // its name is built from Fields that have since changed (an Artefact's `filename:` pattern).
  let approvedPath = usualPath
  try {
    const manifest = parseRenderManifest(await provider.readAtCommit(store, `${outDir}/${RENDER_MANIFEST_FILENAME}`, entry.approvalCommit))
    const recordedName = manifest[artefact.id]
    if (typeof recordedName === 'string' && recordedName && !/[/\\]/.test(recordedName)) approvedPath = `${outDir}/${recordedName}`
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
    // No manifest then: work the name out from the Fields as they were.
    const modules = {}
    for (const moduleId of artefactModuleIds(artefact)) {
      // eslint-disable-next-line no-await-in-loop
      modules[moduleId] = (await approvedModuleFields(definition, provider, base, slug, entry.approvalCommit, moduleId)) ?? {}
    }
    approvedPath = provider.outPath(slug, instanceName, artefact.title, 'docx', filenamePatternContext(artefact, modules, slug))
  }

  try {
    return { bytes: await provider.readBytesAtCommit(store, approvedPath, entry.approvalCommit), filename: baseNameOf(approvedPath) }
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/**
 * Re-renders one earlier stage's Artefact onto the current stage's branch, keeping the approved copy.
 *
 * 1. The approved copy, read at the earlier stage's approval commit, is committed to
 *    `out/approved/<usual name> — approved <date>.docx` (already there from an earlier attempt: left alone).
 * 2. `render()` runs. It is the caller's render of this Artefact onto `branch`, so the new document takes
 *    the usual name and the usual name means the currently approved version. It is the caller's, because
 *    the Document Control block needs review data only the server has.
 * 3. A record of the Fields the render was made from is committed, which is what lets Request approval
 *    see the Artefact was re-rendered (and see it needs doing again if one of those Fields changes).
 *
 * Refuses an Artefact that Request approval would not ask for: its stage isn't flagged, or the Artefact
 * prints none of the changed Fields. Returns `{ artefactId, stageId, path, approvedCopyPath, approvedOn }`;
 * `approvedCopyPath` is `null` when no approved document existed to keep.
 */
export async function reRenderEarlierArtefact({ providerKey, base, slug, definition, instance, branch, artefactId, render }) {
  const provider = remoteProvider(providerKey)
  if (!provider) throw new Error('Re-rendering an earlier stage is for remote workspaces on GitHub, Azure DevOps or GitLab only')

  const flagged = await findChangedSinceApproval({ providerKey, base, slug, definition, instance, currentBranch: branch })
  const match = affectedArtefacts(definition, flagged).find((item) => item.artefact.id === artefactId)
  if (!match) {
    const artefact = definition.artefacts.find((a) => a.id === artefactId)
    throw new Error(
      artefact
        ? `"${artefact.title}" does not need re-rendering: no Field it prints has changed since its stage was approved.`
        : `Definition "${definition.id}" has no artefact "${artefactId}"`
    )
  }
  const { entry, artefact } = match

  const instanceName = instanceDisplayName(instance)
  const store = freshStore(provider, base, branch)
  const usualPath = await usualPathOf(definition, provider, base, slug, branch, instance, artefact)
  const outDir = outDirectoryOf(usualPath)

  // 1. Keep the approved copy.
  let approvedCopyPath = null
  const approved = await approvedDocument({ provider, base, slug, definition, artefact, entry, instanceName, usualPath })
  if (approved) {
    approvedCopyPath = `${outDir}/approved/${approvedCopyFilename(approved.filename, { approvedOn: entry.approvedOn, pullRequestId: entry.pullRequestId })}`
    if (!(await store.fileExists(approvedCopyPath, branch))) {
      await store.writeFiles([{ path: approvedCopyPath, content: approved.bytes.toString('base64'), contentType: 'base64encoded' }], {
        branch,
        message: `Keep the approved ${artefact.title} (${entry.title} approved ${entry.approvedOn ?? `in Pull Request ${entry.pullRequestId}`})`,
      })
    }
  }

  // 2. Render onto the usual name.
  await render()

  // 3. Remember what it was made from.
  const recordPath = `${outDir}/approved/${REAPPROVAL_RECORD_FILENAME}`
  const record = await readRecord(store, recordPath, branch)
  record[artefact.id] = {
    stage: entry.stageId,
    fingerprint: await fingerprintOf(definition, provider, base, slug, branch, artefact),
    approvedCopy: approvedCopyPath ? baseNameOf(approvedCopyPath) : null,
    pullRequestId: entry.pullRequestId,
  }
  await store.writeFiles([{ path: recordPath, content: JSON.stringify(record, null, 2), contentType: 'rawtext' }], {
    branch,
    message: `Record that ${artefact.title} was re-rendered for re-approval of ${entry.title}`,
  })

  return { artefactId: artefact.id, stageId: entry.stageId, path: usualPath, approvedCopyPath, approvedOn: entry.approvedOn }
}
