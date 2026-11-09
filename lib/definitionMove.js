import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadDefinition, getLatestPublishedVersion, loadDefinitionChangelog } from './definition.js'
import { instanceDefinitionVersion } from './instance.js'
import { NotFoundError } from './providerErrors.js'
import { decisionsLogPath } from '../web/lib/decisionsLog.js'
import {
  changelogSection,
  definitionMoveCommitMessage,
  definitionMoveEntry,
  definitionMoveTarget,
  definitionMoveView as viewOfMove,
  definitionMoveWrites,
  planDefinitionMove,
  removedFieldModuleIds,
  writeAllOrRestore,
} from '../web/lib/definitionVersionMove.js'

// #362: the server's half of "Move to v<N>" in Instance Settings, for a server workspace on the server's disk and for a Provider
// workspace (Azure DevOps, GitHub, GitLab). What changes and the files the move writes are web/lib/definitionVersionMove.js's, shared
// with a Local workspace's browser; this only reads the Definition's versions from the server's library (or the workspace's own
// definitions/ folder) and reads and writes the Instance's files through a small adapter, so one answer (`answerDefinitionMove`)
// serves every kind of workspace the same way, from lib/server.js and from lib/blobWorkspaceRoutes.js for a Blob container:
//
//   * `read(path)` resolves a file's text, or `null` when it is not there, `path` relative to the Instance's folder;
//   * `writeAll(files, message)` writes `[{ path, text }]` as one change: one commit on the current Stage's branch for a Provider,
//     one save (each file in turn, put back if a later one fails) for a server workspace, all-or-nothing under the Instance's
//     lease in a Blob container.

/**
 * The move on offer for the Instance `record`, or `null` when its Definition has no newer published version: `{ plan, changelog }`,
 * `plan` being web/lib/definitionVersionMove.js's `planDefinitionMove` (worked out from the two versions and the Module files the
 * move would change) and `changelog` the newer version's own CHANGELOG section, or `null`.
 */
export async function definitionMoveOffer({ record, definitionsDir, read }) {
  const current = instanceDefinitionVersion(record)
  const target = definitionMoveTarget(current, getLatestPublishedVersion(record.definition, definitionsDir))
  if (!target) return null
  const from = loadDefinition(record.definition, { definitionsDir, version: current })
  const to = loadDefinition(record.definition, { definitionsDir, version: target })
  const moduleFiles = {}
  for (const moduleId of removedFieldModuleIds(from, to)) moduleFiles[moduleId] = await read(`modules/${moduleId}.md`)
  const plan = planDefinitionMove({ from, to, stageId: record.stage, moduleFiles })
  let changelog = null
  try {
    changelog = changelogSection(loadDefinitionChangelog(record.definition, target, { definitionsDir }), target)
  } catch {
    // A CHANGELOG is optional; one that can't be read leaves the dialog without it.
  }
  return { plan, changelog }
}

/** What `GET /api/instance/definition-move` answers for an offer (web/lib/definitionVersionMove.js's `definitionMoveView`). */
export const definitionMoveView = (offer, { blocked = null } = {}) => viewOfMove(offer.plan, { changelog: offer.changelog, blocked })

/**
 * Makes the move `offer` describes: the Module files without the dropped Fields, the move's line in the current Stage's decisions log
 * and instance.yaml on the new version, through `writeAll` as one change. Resolves `{ definitionVersion, removed, entry }`.
 */
export async function performDefinitionMove({ slug, offer, read, writeAll, who, now = () => new Date().toISOString() }) {
  const { plan } = offer
  const instanceYaml = await read('instance.yaml')
  const logText = await read(decisionsLogPath(plan.stageId))
  const entry = definitionMoveEntry(plan, { at: now(), who })
  await writeAll(definitionMoveWrites(plan, { instanceYaml, logText, entry }), definitionMoveCommitMessage(slug, plan))
  return { definitionVersion: plan.to, removed: plan.removed, entry }
}

/**
 * Answers `GET` or `POST /api/instance/definition-move` for the Instance `record`, the same for every kind of workspace: the offer on
 * GET, the move on POST once `requestedVersion` is still the latest published version and nothing blocks it. `files` reads (and,
 * without `openWrite`, writes) the Instance's files; `openWrite()` resolves the files to write through instead (a Provider's Stage
 * branch, opened only for the write), and the move is then worked out again from what they hold. `blockedFor(to)` is the sentence
 * saying why the move must wait, or `null`. `send(status, body)` answers; a failed write is a 500 saying nothing was changed, unless
 * `rethrow(err)` says the caller answers that error itself.
 */
export async function answerDefinitionMove({ method, requestedVersion, slug, record, definitionsDir, files, blockedFor = () => null, openWrite, send, rethrow = () => false }) {
  const offer = await definitionMoveOffer({ record, definitionsDir, read: files.read })
  const blocked = offer ? blockedFor(offer.plan.to) : null
  if (method === 'GET') return send(200, offer ? definitionMoveView(offer, { blocked }) : { available: false, definitionVersion: instanceDefinitionVersion(record) })
  if (!offer) {
    return send(409, { error: `"${slug}" is already on the latest published version of ${record.definition} (v${instanceDefinitionVersion(record)}), so there is nothing to move to.` })
  }
  if (requestedVersion !== offer.plan.to) {
    return send(409, { error: `v${offer.plan.to} is now the latest published version of ${record.definition}, not v${requestedVersion}. Nothing was changed: reopen Move to v${offer.plan.to}… to see what it changes.` })
  }
  if (blocked) return send(409, { error: blocked, code: 'awaiting_approval' })
  // A Provider's write opens the Stage's branch first; the move is then worked out again from what that branch holds.
  const target = openWrite ? await openWrite() : { files, offer }
  const moveOffer = target.offer ?? (await definitionMoveOffer({ record, definitionsDir, read: target.files.read }))
  if (moveOffer?.plan.to !== requestedVersion) {
    return send(409, { error: `"${slug}" changed while the move was being made. Nothing was changed: reopen Settings to see the move on offer now.` })
  }
  try {
    const moved = await performDefinitionMove({ slug, offer: moveOffer, read: target.files.read, writeAll: target.files.writeAll })
    return send(200, { slug, ...moved })
  } catch (err) {
    if (rethrow(err)) throw err
    return send(500, { error: `Nothing was changed: the move to v${moveOffer.plan.to} could not be written (${err.message}). Try again.` })
  }
}

/** The adapter for an Instance folder on the server's disk (`instanceDir` is `<workspace folder>/<slug>`). */
export function diskInstanceFiles(instanceDir) {
  const at = (path) => join(instanceDir, path)
  const io = {
    read: async (path) => (existsSync(at(path)) ? readFileSync(at(path), 'utf8') : null),
    write: async (path, text) => {
      mkdirSync(dirname(at(path)), { recursive: true })
      writeFileSync(at(path), text)
    },
    remove: async (path) => rmSync(at(path), { force: true }),
  }
  return { read: io.read, writeAll: (files) => writeAllOrRestore(files, io) }
}

/** The adapter for a Provider-hosted Instance: reads `branch`, and writes every file as one commit on it. */
export function providerInstanceFiles(client, slug, branch) {
  const at = (path) => `gantry-workspace/${slug}/${path}`
  return {
    read: async (path) => {
      try {
        return await client.getFileContent(at(path), { branch })
      } catch (err) {
        if (err instanceof NotFoundError) return null
        throw err
      }
    },
    writeAll: (files, message) => client.writeFiles(files.map(({ path, text }) => ({ path: at(path), content: text })), { branch, message }),
  }
}
