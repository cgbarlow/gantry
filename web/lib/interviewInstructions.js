// #282 (docs/adr/0062-interview-instructions-live-in-the-definition-and-only-add.md) — Interview
// instructions: text a Definition's author writes to steer how the AI interviews an architect. An
// optional `interview:` text key at three levels — the Definition, a Stage and a Module — stacked
// broad to narrow. A Field has none (its `guidance` already does that job).
//
//     interview: Ask who the sponsor is before anything else.   # the Definition
//     stages:
//       - id: design
//         interview: Probe every external integration.          # a Stage
//     # modules/security.yaml
//     interview: Spell "authorisation" with an s.               # a Module
//
// They only ever *add* to Gantry's own interview rules, so nothing here can switch a rule off. They
// are authored on a draft Definition's Definitions page and published with that version, like every
// other key the Definition carries.
//
// `interviewInstructionsProblems` is the rule for a well-formed value, shared by both validators
// (lib/definition.js and web/lib/localStatus.js). A malformed value is reported but never stops a
// Definition loading: `interviewText` reads it as no instructions at all.
//
// Pure and dependency-free, like web/lib/instanceSettings.js, so `lib/` imports it directly.

/** The instructions as the AI would read them: the trimmed text, or '' when absent, blank or not text. */
export function interviewText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Whether a Definition file should carry `interview: value` — anything but absent or blank text. A
 * malformed value (not text) is kept as it is, so validation sees it rather than a Save quietly
 * deleting it.
 */
export function hasInterviewText(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

/** A Definition's `interview` as it holds it — loaded or projected (`interview`) — or `undefined`. */
export function definitionInterview(definition) {
  return definition?.interview
}

/**
 * Problems with the `interview` key at each level of a Definition. `interview` must be text; a blank
 * string is the same as no instructions. Messages open with `Stage "id"` / `Module "id"` like every
 * other problem about those elements, so the Definitions page anchors them there; the Definition's
 * own opens with `Interview instructions`.
 *
 * @param {{ interview?: unknown, stages?: { id: string, interview?: unknown }[], modules?: { id: string, interview?: unknown }[] }} structure `interview` is spelled the same in memory and on disk
 * @returns {{ type: string, message: string }[]}
 */
export function interviewInstructionsProblems({ interview, stages = [], modules = [] } = {}) {
  const problems = []
  const isText = (value) => value === undefined || value === null || typeof value === 'string'
  const describe = (value) => JSON.stringify(value)
  if (!isText(interview)) {
    problems.push({
      type: 'invalid-interview',
      message: `Interview instructions on the Definition are ${describe(interview)} — they must be text`,
    })
  }
  for (const stage of stages) {
    if (!isText(stage?.interview)) {
      problems.push({
        type: 'invalid-interview',
        message: `Stage "${stage.id}" sets "interview" to ${describe(stage.interview)} — Interview instructions must be text`,
      })
    }
  }
  for (const mod of modules) {
    if (!isText(mod?.interview)) {
      problems.push({
        type: 'invalid-interview',
        message: `Module "${mod.id}" sets "interview" to ${describe(mod.interview)} — Interview instructions must be text`,
      })
    }
  }
  return problems
}

/**
 * The Interview instructions that apply when interviewing for one Module at one Stage, broad to
 * narrow: the Definition's, then the Stage's, then the Module's. Levels with nothing to say are left
 * out. `definition` is anything with `{ interview, stages, modules }` — a loaded Definition
 * (`modules` a `Map`) or a version projection (`modules` an array).
 *
 * @param {{ interview?: unknown, stages?: any[], modules?: Map<string, any>|any[] }} definition
 * @param {{ stageId?: string, moduleId?: string }} [at]
 * @returns {{ level: 'definition'|'stage'|'module', id?: string, text: string }[]}
 */
export function stackedInterviewInstructions(definition, { stageId, moduleId } = {}) {
  const modules = definition?.modules
  const moduleSpec = moduleId === undefined ? undefined : modules instanceof Map ? modules.get(moduleId) : (modules ?? []).find((m) => m.id === moduleId)
  const stage = stageId === undefined ? undefined : (definition?.stages ?? []).find((s) => s.id === stageId)
  const stack = []
  const definitionText = interviewText(definition?.interview)
  if (definitionText) stack.push({ level: 'definition', text: definitionText })
  const stageText = interviewText(stage?.interview)
  if (stageText) stack.push({ level: 'stage', id: stage.id, text: stageText })
  const moduleText = interviewText(moduleSpec?.interview)
  if (moduleText) stack.push({ level: 'module', id: moduleSpec.id, text: moduleText })
  return stack
}
