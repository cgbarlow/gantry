// #297 (map #238, decided in #249): gathers what web/lib/outOfDate.js needs from the stores every workspace kind already has and returns
// the flags. Plain (no signals), so the browser's watcher (web/lib/outOfDateState.js) and the server's `/api/instance/out-of-date` route
// (#305, which the MCP server's get_instance reads) share one implementation.
import { findOutOfDateFields, newSinceLastInterview, repositoryReadsOf } from './outOfDate.js'
import { isRemovedSource, isRepositorySource, replacedByMap } from './sourceDocuments.js'

const EMPTY = Object.freeze({ flags: [], newSince: [], sources: [], unchecked: [] })

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
 * @param {(entry: object, reads: {path: string, commit: string}[]) => Promise<{head: string, results: object[]}>} [input.compareRepository]  #319: has the Gantry server compare a code repository's files at their recorded commits with its branch head; without it repositories are not checked
 * @returns {Promise<{flags: object[], newSince: object[], sources: object[], unchecked: {source: string, title: string, code: string|null, reason: string}[]}>}  `unchecked` (#319): the code repositories a Field drew on that could not be compared just now, and why
 */
export async function loadOutOfDate({ sourceStore, decisionsStore, stages = [], currentStageId, currentModules = [], loadStageModules, compareRepository }) {
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
  const unchecked = []
  const repositories = compareRepository ? sources.filter((e) => isRepositorySource(e) && !isRemovedSource(e)) : []
  if (hasChange(sources) || hasFieldInput(logs) || repositories.length) {
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
    // #319: each repository a Field drew on is compared once, for just the files drawn on. One that can't be read now is no evidence either
    // way, so it flags nothing, but it is named in `unchecked` with the reason (most often: this reader has no access), so the architect is
    // told rather than left thinking it was checked.
    const repositoryChanges = {}
    const reads = repositories.length ? repositoryReadsOf({ sources, logs, modules: Object.values(modules) }) : {}
    for (const entry of repositories) {
      if (!reads[entry.id]?.length) continue
      try {
        repositoryChanges[entry.id] = await compareRepository(entry, reads[entry.id])
      } catch (err) {
        unchecked.push({ source: entry.id, title: entry.title ?? entry.id, code: err?.code ?? null, reason: err?.message ?? 'it could not be read' })
      }
    }
    flags = findOutOfDateFields({ sources, logs, modules: Object.values(modules), stageModules, repositoryChanges })
  }
  return { flags, newSince, sources, unchecked }
}
