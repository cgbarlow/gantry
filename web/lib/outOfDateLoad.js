// #297 (map #238, decided in #249): gathers what web/lib/outOfDate.js needs from the stores every workspace kind already has and returns
// the flags. Plain (no signals), so the browser's watcher (web/lib/outOfDateState.js) and the server's `/api/instance/out-of-date` route
// (#305, which the MCP server's get_instance reads) share one implementation.
import { findOutOfDateFields, newSinceLastInterview } from './outOfDate.js'
import { isRemovedSource, replacedByMap } from './sourceDocuments.js'

const EMPTY = Object.freeze({ flags: [], newSince: [], sources: [] })

const hasChange = (entries) => {
  const replaced = replacedByMap(entries)
  return entries.some((e) => isRemovedSource(e) || e.textChangedAt || replaced.has(e.id))
}
const hasFieldInput = (logs) => Object.values(logs).some((log) => Object.values(log?.fields ?? {}).some((record) => (record?.inputs ?? []).some((input) => typeof input?.field === 'string')))

/**
 * @param {object} input
 * @param {{ list(): Promise<{entries: object[]}> }} input.sourceStore
 * @param {{ read(stageId: string): Promise<object> }|null} input.decisionsStore  null where the workspace keeps no readable log (the remote-session tickets add it)
 * @param {{id: string}[]} input.stages
 * @param {string} input.currentStageId  the Stage on screen
 * @param {object[]|(() => Promise<object[]>)} input.currentModules  its Modules as the editor holds them (or a function that reads them, called only when the saved content is needed)
 * @param {(stage: {id: string}) => Promise<object[]>} input.loadStageModules  another Stage's saved Modules
 */
export async function loadOutOfDate({ sourceStore, decisionsStore, stages = [], currentStageId, currentModules = [], loadStageModules }) {
  const { entries } = await sourceStore.list()
  const sources = entries ?? []
  if (sources.length === 0) return { ...EMPTY }

  const logs = {}
  if (decisionsStore) {
    for (const stage of stages) {
      try {
        logs[stage.id] = await decisionsStore.read(stage.id)
      } catch {
        // A log that can't be read is no evidence either way, so it contributes nothing rather than hiding the rest.
      }
    }
  }
  const newSince = newSinceLastInterview(sources, logs)

  // The saved content is needed only when something could be flagged: a changed document (for citations and drafted Fields), or a draft that drew on an earlier Field.
  let flags = []
  if (hasChange(sources) || hasFieldInput(logs)) {
    const byStage = { [currentStageId]: typeof currentModules === 'function' ? await currentModules() : currentModules }
    for (const stage of stages) {
      if (stage.id === currentStageId) continue
      try {
        byStage[stage.id] = await loadStageModules(stage)
      } catch {
        // An unreadable Stage is skipped: its Fields are not guessed at.
      }
    }
    const modules = {}
    const stageModules = {}
    for (const [stageId, list] of Object.entries(byStage)) {
      stageModules[stageId] = list.map((m) => m.id)
      for (const m of list) {
        const there = modules[m.id] ?? { id: m.id, fields: [] }
        for (const f of m.fields ?? []) if (!there.fields.some((x) => x.id === f.id)) there.fields.push({ id: f.id, value: f.value })
        modules[m.id] = there
      }
    }
    flags = findOutOfDateFields({ sources, logs, modules: Object.values(modules), stageModules })
  }
  return { flags, newSince, sources }
}
