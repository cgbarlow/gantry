import { NotFoundError } from './providerErrors.js'
import { readModule } from './instance.js'
import { flagsForField, outOfDateBannerLines, outOfDateFieldNote, outOfDateKeys } from '../web/lib/outOfDate.js'
import { loadOutOfDate } from '../web/lib/outOfDateLoad.js'

// #305 (ADR-0067): which Fields of an Instance are Out of date, worked out on the server so the MCP server's get_instance can report them.
// The detection itself is the browser's (web/lib/outOfDate.js, gathered by web/lib/outOfDateLoad.js); this file only supplies the reads
// that code is written against, for a workspace kind that keeps its files on the server or in a Provider's repository, and shapes the
// answer for an outside agent. Nothing is stored: like the browser's marks, the answer is worked out from the manifest, the decisions logs
// and the saved content each time.

/** One Stage's saved Modules as `loadOutOfDate` takes them (`[{ id, fields: [{ id, value }] }]`); a Module with nothing saved yet has no Fields. `options` is what `readModule` takes. */
export async function readStageModulesForOutOfDate(definition, slug, stage, options) {
  const modules = []
  for (const moduleId of stage.modules) {
    let data = { fields: {} }
    try {
      data = await readModule(definition, slug, moduleId, options)
    } catch (err) {
      if (!(err instanceof NotFoundError) && !/has no saved data|ENOENT|not found/i.test(err.message)) throw err
    }
    modules.push({ id: moduleId, fields: Object.entries(data.fields ?? {}).map(([id, value]) => ({ id, value })) })
  }
  return modules
}

function fieldTitle(definition, key) {
  const [moduleId, ...rest] = String(key).split('.')
  const fieldId = rest.join('.')
  const spec = definition.modules.get(moduleId)
  const field = spec?.fields?.find((candidate) => candidate.id === fieldId)
  return spec ? `${spec.title} · ${field?.title ?? fieldId}` : key
}

/**
 * The Out of date Fields of one Instance, for an outside agent:
 *
 *   { supported: true, fields: [{ field, title, note, flags: [{ cause, change, source?, sourceTitle?, inputField?, since?, replacedBy?, via, stages }] }],
 *     summary: ['4 Fields drew on Client brief, now replaced'], newSinceLastInterview: [{ id, title }] }
 *
 * `sourceStore` lists the Instance's Source documents; `readLog(stageId)` reads a Stage's decisions log (`null` where the workspace keeps
 * no readable one, as on a Provider so far); `readStageModules(stage)` reads a Stage's saved Modules (`readStageModulesForOutOfDate`).
 */
export async function describeOutOfDate({ sourceStore, readLog, definition, currentStageId, readStageModules }) {
  const { flags, newSince } = await loadOutOfDate({
    sourceStore,
    decisionsStore: readLog ? { read: readLog } : null,
    stages: definition.stages,
    currentStageId,
    currentModules: () => readStageModules(definition.stages.find((stage) => stage.id === currentStageId)),
    loadStageModules: readStageModules,
  })
  return {
    supported: true,
    fields: outOfDateKeys(flags).map((key) => ({
      field: key,
      title: fieldTitle(definition, key),
      note: outOfDateFieldNote(flagsForField(flags, key)),
      flags: flagsForField(flags, key).map(({ field: _field, ...rest }) => rest),
    })),
    summary: outOfDateBannerLines(flags).map((line) => line.text),
    newSinceLastInterview: newSince.map((entry) => ({ id: entry.id, title: entry.title })),
  }
}
