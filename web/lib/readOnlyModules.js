// #152 (docs/adr/0050): a Stage's `read-only-modules` — the subset of its `modules` it mounts only so
// its documents can render and its Gate can be evaluated, not so its owner can edit them. Every
// loader, the gate check and the renderer keep reading `modules` unchanged; only the editing
// surfaces ask this file: the instance editor (lib/server.js's buildModuleEntry and its browser twin
// in web/lib/localInstanceFiles.js), the server's module-write routes, and validation
// (lib/definition.js and web/lib/localStatus.js). Pure and dependency-free, so `lib/` imports it
// directly (as lib/workspaceDirectory.js does web/lib/localWorkspace.js) rather than keeping a port.
//
// Stages here are the camelCase in-memory shape (`readOnlyModules`); a caller holding raw YAML maps
// `read-only-modules` across first.

/**
 * Where a Module read-only at `stageId` is edited instead: the nearest earlier Stage that mounts it
 * and doesn't list it read-only. Returns `undefined` when the Module is editable at `stageId` (the
 * Stage doesn't exist, doesn't list the Module read-only, or lists nothing read-only — the opt-in
 * default), and `{ homeStage }` when it is read-only — `homeStage` is `{ id, title }`, or `null` when
 * no earlier Stage owns it (it is then read-only with nowhere to edit it, which the Definition allows).
 *
 * @param {{ id: string, title?: string, modules?: string[], readOnlyModules?: string[] }[]} stages
 * @param {string} stageId
 * @param {string} moduleId
 * @returns {{ homeStage: { id: string, title: string } | null } | undefined}
 */
export function readOnlyModuleAt(stages = [], stageId, moduleId) {
  const index = stages.findIndex((s) => s.id === stageId)
  if (index === -1 || !isListedReadOnly(stages[index], moduleId)) return undefined
  for (let i = index - 1; i >= 0; i -= 1) {
    const stage = stages[i]
    if ((stage.modules ?? []).includes(moduleId) && !isListedReadOnly(stage, moduleId)) {
      return { homeStage: { id: stage.id, title: stage.title ?? stage.id } }
    }
  }
  return { homeStage: null }
}

function isListedReadOnly(stage, moduleId) {
  return Array.isArray(stage.readOnlyModules) && stage.readOnlyModules.includes(moduleId)
}

/**
 * Validation for `read-only-modules`: it must be a list, and every id in it must be one of the
 * same Stage's `modules` — read-only describes how a Stage mounts a Module, so it can't name one the
 * Stage doesn't mount. Messages open with `Stage "id"` so the Definitions page anchors the marker.
 *
 * @param {{ id: string, modules?: string[], readOnlyModules?: unknown }[]} stages
 * @returns {{ type: string, message: string }[]}
 */
export function readOnlyModuleProblems(stages = []) {
  const problems = []
  for (const stage of stages) {
    const listed = stage.readOnlyModules
    if (listed === undefined || listed === null) continue
    if (!Array.isArray(listed) || listed.some((id) => typeof id !== 'string')) {
      problems.push({
        type: 'invalid-read-only-modules',
        message: `Stage "${stage.id}" has "read-only-modules" that is not a list of module ids`,
      })
      continue
    }
    for (const moduleId of listed) {
      if (!(stage.modules ?? []).includes(moduleId)) {
        problems.push({
          type: 'unknown-read-only-module',
          message: `Stage "${stage.id}" lists module "${moduleId}" as read-only, but the stage doesn't mount it — add it to the stage's modules or remove it from "read-only-modules"`,
        })
      }
    }
  }
  return problems
}

/**
 * The refusal the server gives a write to a Module that is read-only at the Stage being written —
 * `null` when every Module in `moduleIds` is editable there. Names the home Stage, so an author (or
 * an agent over MCP) knows where the content is owned.
 *
 * @param {{ id: string, title?: string, modules?: string[], readOnlyModules?: string[] }[]} stages
 * @param {{ id: string, title?: string }} stage  the Stage being written
 * @param {string[]} moduleIds
 * @param {(moduleId: string) => string} [moduleTitle]
 * @returns {string | null}
 */
export function readOnlyWriteRefusal(stages, stage, moduleIds, moduleTitle = (id) => id) {
  const refusals = []
  for (const moduleId of moduleIds) {
    const readOnly = readOnlyModuleAt(stages, stage.id, moduleId)
    if (!readOnly) continue
    const where = readOnly.homeStage
      ? `it is carried forward from stage "${readOnly.homeStage.title}" (${readOnly.homeStage.id}) — edit it there`
      : 'no earlier stage owns it'
    refusals.push(`Module "${moduleTitle(moduleId)}" (${moduleId}) is read-only at stage "${stage.title ?? stage.id}" (${stage.id}): ${where}.`)
  }
  return refusals.length ? refusals.join(' ') : null
}
