// #202 (spec #192, docs/adr/0054): an Instance's **Target size** — Small, Medium or Large, default
// Medium — and the per-Field word budgets (`target-words`) it picks between. Size is an authoring
// target, not a render-time transformation: nothing here is consulted by the gate check or the
// renderer. Its only readers are the places an author (a person, or an AI agent over MCP) writes
// content: the instance editor's per-Field target and live word count, `GET /api/instance` (and so
// MCP `get_instance`), the over-budget notes `PUT /api/instance/modules` returns (and so MCP
// `update_instance_modules`), and Definition validation. Pure and dependency-free, so `lib/` imports
// it directly (as it does web/lib/readOnlyModules.js) rather than keeping a port.
//
// Fields here are the camelCase in-memory shape (`targetWords`); a caller holding raw YAML maps
// `target-words` across first.

export const TARGET_SIZES = ['small', 'medium', 'large']
export const DEFAULT_TARGET_SIZE = 'medium'

const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' }

// Only prose has a length worth budgeting: a select, text or date Field holds one short value.
const BUDGETED_FIELD_TYPES = new Set(['markdown', 'list'])

export function isTargetSize(value) {
  return TARGET_SIZES.includes(value)
}

/** The size an Instance works to: its stored `size`, or Medium when it has none (or a value Gantry doesn't know). */
export function effectiveTargetSize(storedSize) {
  return isTargetSize(storedSize) ? storedSize : DEFAULT_TARGET_SIZE
}

export function targetSizeLabel(size) {
  return SIZE_LABELS[effectiveTargetSize(size)]
}

/**
 * The `invalid-target-words` problem for one Field's `target-words` value (`value` is the key read
 * under either spelling), or `null` when it is absent or well-formed: a positive whole number of words
 * for each of small, medium and large, and nothing else, on a markdown or list Field. The message
 * starts `Module "<id>" field "<id>"` so the Definitions page anchors its marker on the Field.
 */
export function targetWordsProblem(moduleId, field, value) {
  if (value === undefined) return null
  const where = `Module "${moduleId}" field "${field.id}"`
  if (!BUDGETED_FIELD_TYPES.has(field.type)) {
    return {
      type: 'invalid-target-words',
      message: `${where} sets "target-words", but is type "${field.type}" — only markdown and list fields hold prose to budget`,
    }
  }
  const wellFormed =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => isTargetSize(key)) &&
    TARGET_SIZES.every((size) => Number.isInteger(value[size]) && value[size] > 0)
  if (wellFormed) return null
  return {
    type: 'invalid-target-words',
    message: `${where} sets "target-words" to ${JSON.stringify(value)} — it must give a positive whole number of words for each of small, medium and large, e.g. "target-words: { small: 40, medium: 100, large: 200 }"`,
  }
}

function hasBudget(field) {
  return field?.targetWords !== undefined && targetWordsProblem('', field, field.targetWords) === null
}

/** A Field's word budget at `size` (Medium when `size` isn't one), or `null` when it declares no well-formed budget. */
export function fieldTargetWords(field, size) {
  return hasBudget(field) ? field.targetWords[effectiveTargetSize(size)] : null
}

function moduleList(modules) {
  if (!modules) return []
  return modules instanceof Map ? [...modules.values()] : [...modules]
}

/**
 * Whether any Field of a Definition declares a word budget — the one switch that shows Target size
 * anywhere. A Definition with none (design v1/v2, recruitment-onboarding) shows no size, no targets
 * and no word counts, exactly as before. `modules` is a loaded Definition's `Map` or a projection's
 * array.
 */
export function definitionHasTargetWords(modules) {
  return moduleList(modules).some((mod) => (mod?.fields ?? []).some(hasBudget))
}

/** How many Fields of a Definition declare a well-formed word budget — what the Definitions page cites for why Size is offered. */
export function targetWordsFieldCount(modules) {
  return moduleList(modules).reduce((count, mod) => count + (mod?.fields ?? []).filter(hasBudget).length, 0)
}

/**
 * Words in a Field's value as a reader would count them: Markdown punctuation (`-`, `|`, `#`, `**`)
 * is not a word, a link counts its text, and fenced code blocks (a Mermaid diagram's source) and
 * images are left out. A list Field's items are counted together. Advisory, so it aims to be
 * predictable rather than exact.
 */
export function countWords(value) {
  const text = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''
  const prose = []
  let fence = null
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }
    prose.push(line)
  }
  const stripped = prose
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return stripped.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length
}

/**
 * `response` (the `GET /api/instance` shape: `{ modules: [{ id, fields: [{ id, ... }] }] }`) with the
 * Instance's `size` and each budgeted Field's `targetWords` — its budget at that size — added; the
 * response itself, unchanged, for a Definition with no budgets. Shared by the server route and the
 * Local Workspace's own loader so both editors see the same thing.
 */
export function withTargetWords(response, modules, storedSize) {
  if (!definitionHasTargetWords(modules)) return response
  const size = effectiveTargetSize(storedSize)
  const specs = new Map(moduleList(modules).map((mod) => [mod.id, mod]))
  return {
    ...response,
    size,
    modules: (response.modules ?? []).map((entry) => ({
      ...entry,
      fields: (entry.fields ?? []).map((field) => {
        if (field.custom) return field
        const spec = specs.get(entry.id)?.fields?.find((f) => f.id === field.id)
        const target = fieldTargetWords(spec, size)
        return target === null ? field : { ...field, targetWords: target }
      }),
    })),
  }
}

/**
 * One note per Field in `written` (`{ [moduleId]: { fields: { [fieldId]: value } } }`, the body of a
 * stage Save) whose word count is over its budget at the Instance's size, e.g.
 * `nfrs.performance: 420 words, Medium target ~150`. Notes never fail a write: they are returned
 * beside it so an author — usually an AI agent over MCP — can tighten the Field and save again.
 */
export function overTargetNotes(modules, written, storedSize) {
  const size = effectiveTargetSize(storedSize)
  const specs = new Map(moduleList(modules).map((mod) => [mod.id, mod]))
  const notes = []
  for (const [moduleId, record] of Object.entries(written ?? {})) {
    const fields = record?.fields
    if (!fields || typeof fields !== 'object') continue
    for (const [fieldId, value] of Object.entries(fields)) {
      const target = fieldTargetWords(specs.get(moduleId)?.fields?.find((f) => f.id === fieldId), size)
      if (target === null) continue
      const words = countWords(value)
      if (words <= target) continue
      notes.push({
        module: moduleId,
        field: fieldId,
        words,
        target,
        size,
        message: `${moduleId}.${fieldId}: ${words} words, ${targetSizeLabel(size)} target ~${target}`,
      })
    }
  }
  return notes
}

/**
 * A Field (camelCase) with its budget at `size` set to `rawValue` from a Definition editor's number
 * input — a whole number keeps it, blank removes it — dropping `targetWords` entirely once every
 * size is blank, so a Field that never had a budget saves exactly as before.
 */
export function withFieldTargetWords(field, size, rawValue) {
  const next = { ...field }
  const budget = { ...(field.targetWords ?? {}) }
  const text = String(rawValue ?? '').trim()
  if (text === '') delete budget[size]
  else budget[size] = Number(text)
  if (Object.keys(budget).length === 0) delete next.targetWords
  else next.targetWords = Object.fromEntries(TARGET_SIZES.filter((s) => budget[s] !== undefined).map((s) => [s, budget[s]]))
  return next
}
