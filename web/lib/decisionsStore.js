// #288 (map #238, docs/adr/0064): the browser's way to read and write a Stage's decisions log (`interview/<stageId>.yaml`, see
// web/lib/decisionsLog.js). Both stores have the same two methods, so the Interview page and the editor's Decisions log panel do not care
// which kind of workspace they are on:
//
//   read(stageId)           -> the committed log (an empty one when there is none)
//   write(stageId, delta)   -> the log after `delta` (`{ status?, fields?, entries? }`) is appended; refused if it would change an entry
//
// A Local workspace reads and writes the file through its folder handle (no server round trip, ADR-0029). A server workspace goes
// through /api/instance/decisions. A stage Save does not call `write`: it carries the delta with the Modules (`planLocalDecisions` for a
// Local workspace, `decisions` in the body of PUT /api/instance/modules otherwise), so the log and the content are one Save.
import { DecisionsLogError, applyDecisionsDelta, decisionsLogPath, parseDecisionsLog, serializeDecisionsLog } from './decisionsLog.js'
import { readTextFile, writeTextFile } from './localWorkspace.js'

const isMissing = (err) => err?.name === 'NotFoundError' || err?.name === 'TypeMismatchError'
const localPath = (slug, stageId) => `gantry-workspace/${slug}/${decisionsLogPath(stageId)}`

/** The committed log of `stageId` in a Local workspace folder. */
export async function readLocalDecisionsLog(handle, slug, stageId) {
  try {
    return parseDecisionsLog(await readTextFile(handle, localPath(slug, stageId)), stageId)
  } catch (err) {
    if (isMissing(err)) return parseDecisionsLog(null, stageId)
    throw err
  }
}

/** The file a Local workspace Save is to write for `delta`: `{ path, text, log }`. Throws `DecisionsLogError` if it would change an entry. */
export async function planLocalDecisions(handle, slug, stageId, delta) {
  const log = applyDecisionsDelta(await readLocalDecisionsLog(handle, slug, stageId), delta, stageId)
  return { path: localPath(slug, stageId), text: serializeDecisionsLog(log), log }
}

export function createLocalDecisionsStore(handle, slug) {
  return {
    read: (stageId) => readLocalDecisionsLog(handle, slug, stageId),
    async write(stageId, delta) {
      const plan = await planLocalDecisions(handle, slug, stageId, delta)
      await writeTextFile(handle, plan.path, plan.text)
      return plan.log
    },
  }
}

/** `fetchForInstance(url, init)` is `apiFetchForInstance` bound to this Instance's slug. */
export function createServerDecisionsStore(slug, fetchForInstance) {
  const path = (stageId) => `/api/instance/decisions?slug=${encodeURIComponent(slug)}&stage=${encodeURIComponent(stageId)}`
  async function parse(res, failure) {
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new DecisionsLogError(body.error ?? body.message ?? `${failure} (${res.status})`, { code: body.code, status: res.status })
    return body.log
  }
  return {
    read: async (stageId) => parse(await fetchForInstance(path(stageId)), 'Failed to read the decisions log'),
    write: async (stageId, delta) =>
      parse(await fetchForInstance(path(stageId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: delta }) }), 'Failed to save the decisions log'),
  }
}
