// #306 (parent #238, docs/adr/0067): the per-Field check on **every content write**. `PUT /api/instance/modules` (and so MCP's
// `update_instance_modules`) runs each Field it writes through the same check the AI interview's draft field step runs on a
// draft (web/lib/interviewDraft.js's `checkDraft`), in a session or not:
//
//   * a select value is one of the Field's options (as written: the stored value is what is checked);
//   * the word count is within the Field's budget at the Instance's Target size;
//   * every figure is cited with a `source:` link or marked "(target assumption)".
//
// The problems come back as notes beside the write and never block it, as the over-budget notes always have. Nothing here has
// a rule of its own: it only walks the body of a Save and asks `checkDraft`. Pure and dependency-free of the server, so the
// unit tests drive it directly.
import { checkDraft } from './interviewDraft.js'
import { effectiveTargetSize } from './targetSize.js'

// What `checkDraft` can also report (a date's shape, a citation to an unknown Source document) is not part of the write check.
const WRITE_CHECK_KINDS = new Set(['options', 'budget', 'figures'])

function moduleSpecs(modules) {
  if (!modules) return new Map()
  const list = modules instanceof Map ? [...modules.values()] : [...modules]
  return new Map(list.map((mod) => [mod.id, mod]))
}

/**
 * One note per problem in the Fields of `written` (`{ [moduleId]: { fields: { [fieldId]: value } } }`, the body of a stage
 * Save), as `{ module, field, kind, message }`; `[]` for a clean write. A Field the Definition does not declare (a custom
 * section) has no rules to check and gets none. `storedSize` is the Instance's stored Target size.
 */
export function fieldWriteNotes(modules, written, storedSize) {
  const size = effectiveTargetSize(storedSize)
  const specs = moduleSpecs(modules)
  const notes = []
  for (const [moduleId, record] of Object.entries(written ?? {})) {
    const fields = record?.fields
    if (!fields || typeof fields !== 'object') continue
    for (const [fieldId, value] of Object.entries(fields)) {
      const field = specs.get(moduleId)?.fields?.find((f) => f.id === fieldId)
      if (!field) continue
      const { problems } = checkDraft(field, value, { size, exact: true, label: `${moduleId}.${fieldId}` })
      for (const problem of problems) {
        if (WRITE_CHECK_KINDS.has(problem.kind)) notes.push({ module: moduleId, field: fieldId, kind: problem.kind, message: problem.message })
      }
    }
  }
  return notes
}
