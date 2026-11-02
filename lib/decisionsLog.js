import { join } from 'node:path'
import { DecisionsLogError, applyDecisionsDelta, decisionsLogPath, parseDecisionsLog, serializeDecisionsLog } from '../web/lib/decisionsLog.js'
import { getTextVersionedOrNull } from './storageFiles.js'

// #288 (map #238, docs/adr/0064): a server workspace's decisions log, `interview/<stageId>.yaml` in the Instance's own folder, read and
// written through the storage layer like the Instance's Modules so a Blob container can sit behind it (docs/adr/0070). The file's shape,
// the append-only rule and the status block's guarantee that no key or address reaches the file are web/lib/decisionsLog.js's, shared with
// a Local workspace; this file only adds where it lives on the server and how a Save puts it in the same write as the Stage's content.

/** The stage id is part of a file name, so it has to be a plain id. */
function assertStageId(stageId) {
  if (typeof stageId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(stageId)) throw new DecisionsLogError(`"${stageId}" is not a Stage id.`, { code: 'bad-request' })
}

/** The file's path inside the Instance's folder, as a storage key under `instancesDir`. */
export function decisionsLogKey(instancesDir, slug, stageId) {
  assertStageId(stageId)
  return join(instancesDir, slug, decisionsLogPath(stageId))
}

/** The Stage's committed log (an empty one when there is none). */
export async function readDecisionsLog(storage, instancesDir, slug, stageId) {
  const found = await getTextVersionedOrNull(storage, decisionsLogKey(instancesDir, slug, stageId))
  return parseDecisionsLog(found?.text ?? null, stageId)
}

/**
 * The file a Save is to write for `delta` (`{ status?, fields?, entries? }`): the committed log with the delta applied, as
 * `{ path, text }` where `path` is relative to the Instance's folder (what `writeModules`'s `extraFiles` takes). Throws
 * `DecisionsLogError` when the delta would change or remove an entry already in the log. Nothing is written here.
 */
export async function planDecisionsWrite(storage, instancesDir, slug, stageId, delta) {
  const before = await readDecisionsLog(storage, instancesDir, slug, stageId)
  const after = applyDecisionsDelta(before, delta, stageId)
  return { path: decisionsLogPath(stageId), text: serializeDecisionsLog(after), log: after }
}

/** True when `delta` has anything to write. */
export const hasDecisionsDelta = (delta) => Boolean(delta && typeof delta === 'object' && (delta.status || delta.fields || (Array.isArray(delta.entries) && delta.entries.length)))
