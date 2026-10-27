// #194 (docs/adr/0052): an Artefact's front matter — `cover-page`, `table-of-contents`, the
// `cover-classification` pointer and (#205) `cover-purpose`, the statement the cover prints for its
// reader. All of them are opt-in: absent (or `false`) means the document renders exactly as before.
// The render honours them in lib/render.js's compileArtefact; this file holds the
// rules both validators share — lib/definition.js (gantry validate, load, Save and Publish everywhere)
// and web/lib/localStatus.js (a Local Workspace) — and the list of Fields both Definition editors
// offer as a classification. Pure and dependency-free, so `lib/` imports it directly (as it does
// web/lib/readOnlyModules.js) rather than keeping a port that could drift.
//
// Artefacts here are the camelCase in-memory shape (`coverPage`, `tableOfContents`,
// `coverClassification`, `coverPurpose`); a caller holding raw YAML maps the kebab-case keys across
// first.

const FRONT_MATTER_SWITCHES = [
  { key: 'cover-page', prop: 'coverPage', type: 'invalid-cover-page' },
  { key: 'table-of-contents', prop: 'tableOfContents', type: 'invalid-table-of-contents' },
]

// A classification is one value printed on one line of the cover, so only a single-valued select or
// text Field can hold it — the same reasoning that limits a filename token (ADR-0045), minus `date`.
function canClassify(field) {
  return field.type === 'text' || (field.type === 'select' && field.multiple !== true)
}

// Whether `module.field` is in the Artefact's own `requires`, directly (with or without `?`) or
// through a bare `module` entry. The same rule as a filename token's (lib/definition.js's
// artefactRequiresField): an Artefact's render only reads the Modules it requires, so a Field outside
// them would always print blank.
function requiresField(artefact, moduleId, fieldId) {
  return (artefact.requires ?? []).some((requirement) => {
    const ref = requirement.endsWith('?') ? requirement.slice(0, -1) : requirement
    const dot = ref.indexOf('.')
    return dot === -1 ? ref === moduleId : ref.slice(0, dot) === moduleId && ref.slice(dot + 1) === fieldId
  })
}

/**
 * Splits a `cover-classification` value into the Field it names, or `null` when it isn't a
 * `module.field` string. The render uses this too, so a value validation would refuse prints nothing.
 *
 * @param {unknown} pointer
 * @returns {{ moduleId: string, fieldId: string } | null}
 */
export function parseCoverClassification(pointer) {
  if (typeof pointer !== 'string') return null
  const match = /^([^.\s?]+)\.([^.\s?]+)$/.exec(pointer)
  return match ? { moduleId: match[1], fieldId: match[2] } : null
}

/**
 * The statement an Artefact's cover prints as its purpose line (#205), as the one line the cover
 * shows (whitespace, newlines included, collapsed), or '' when `cover-purpose` is absent or not
 * a string with something in it. The render uses this too, so a value validation would refuse prints
 * nothing — and the cover never falls back to the author-facing `purpose`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function coverPurposeLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Problems with an Artefact's front-matter keys. `cover-page` and `table-of-contents` take only a real
 * boolean: anything else ("yes", 1, the string "true") is refused rather than guessed at, since the
 * render only honours a real `true`. `cover-classification` must name a single-valued select or text
 * Field that is in the Artefact's own `requires`. `cover-purpose` (#205) must be a string with
 * something in it: it is printed as it is, so a blank or a non-string has nothing to print. Each
 * message opens with `Artefact "<id>"`, which is how the Definitions page anchors its marker.
 *
 * @param {{ id: string, requires?: string[], coverPage?: unknown, tableOfContents?: unknown, coverClassification?: unknown, coverPurpose?: unknown }} artefact
 * @param {(moduleId: string, fieldId: string) => ({ type: string, multiple?: boolean } | undefined)} findField
 * @returns {{ type: string, message: string }[]}
 */
export function artefactFrontMatterProblems(artefact, findField) {
  const problems = []
  for (const { key, prop, type } of FRONT_MATTER_SWITCHES) {
    const value = artefact[prop]
    if (value !== undefined && typeof value !== 'boolean') {
      problems.push({ type, message: `Artefact "${artefact.id}" sets "${key}" to ${JSON.stringify(value)} — it must be true or false` })
    }
  }

  if (artefact.coverPurpose !== undefined && !coverPurposeLine(artefact.coverPurpose)) {
    problems.push({ type: 'invalid-cover-purpose', message: `Artefact "${artefact.id}" sets "cover-purpose" to ${JSON.stringify(artefact.coverPurpose)} — it must be a statement for the cover to print` })
  }

  const pointer = artefact.coverClassification
  if (pointer === undefined) return problems
  const problem = (message) => problems.push({ type: 'invalid-cover-classification', message: `Artefact "${artefact.id}" ${message}` })
  const named = parseCoverClassification(pointer)
  if (!named) {
    problem(`sets "cover-classification" to ${JSON.stringify(pointer)} — it must name one field as "module.field"`)
    return problems
  }
  const field = findField(named.moduleId, named.fieldId)
  if (!field) {
    problem(`cover-classification: "${pointer}" is not a field in this definition`)
  } else if (!canClassify(field)) {
    problem(`cover-classification: "${pointer}" is type "${field.type}"${field.multiple === true ? ' with multiple: true' : ''} — only a single-valued select or text field can classify a document`)
  } else if (!requiresField(artefact, named.moduleId, named.fieldId)) {
    problem(`cover-classification: "${pointer}" is not in this artefact's own "requires" list`)
  }
  return problems
}

/**
 * The Fields an Artefact's `cover-classification` may name — exactly what
 * `artefactFrontMatterProblems` accepts — for the Definition editors to offer, in `requires` order.
 *
 * @param {{ id: string, fields?: { id: string, title?: string, type: string, multiple?: boolean }[] }[]} modules
 * @param {{ requires?: string[] }} artefact
 * @returns {{ value: string, label: string }[]}
 */
export function coverClassificationOptions(modules, artefact) {
  const options = []
  const seen = new Set()
  for (const requirement of artefact.requires ?? []) {
    const ref = requirement.endsWith('?') ? requirement.slice(0, -1) : requirement
    const dot = ref.indexOf('.')
    const moduleId = dot === -1 ? ref : ref.slice(0, dot)
    const fieldId = dot === -1 ? null : ref.slice(dot + 1)
    const mod = (modules ?? []).find((m) => m.id === moduleId)
    if (!mod) continue
    for (const field of (mod.fields ?? []).filter((f) => (fieldId ? f.id === fieldId : true))) {
      const value = `${moduleId}.${field.id}`
      if (!canClassify(field) || seen.has(value)) continue
      seen.add(value)
      options.push({ value, label: `${mod.title ?? moduleId} · ${field.title ?? field.id}` })
    }
  }
  return options
}
