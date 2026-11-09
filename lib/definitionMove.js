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
// definitions/ folder) and reads and writes the Instance's files through a small adapter, so the one route in lib/server.js serves
// every kind of workspace the same way:
//
//   * `read(path)` resolves a file's text, or `null` when it is not there, `path` relative to the Instance's folder;
//   * `writeAll(files, message)` writes `[{ path, text }]` as one change: one commit on the current Stage's branch for a Provider,
//     one save (each file in turn, put back if a later one fails) for a server workspace.

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
