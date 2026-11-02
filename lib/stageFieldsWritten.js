// Which Fields a stage-level Save would change, set against what is saved now (ADR-0068, #272).
//
// MCP's `update_instance_modules` writes a partial record per Module. When the call carries the
// stage version it read and the stage has moved on, the refusal names the Fields in the call whose
// saved content differs (`differingFields`), so the agent can re-read them and settle the clash with
// the architect. When the call carries no version (an agent that predates the check) it still saves,
// and the response names every Field the call overwrote (`overwrittenFields`): those that held
// content and now hold something different.
//
// Pure and synchronous: `current` is the stage's saved payloads (web/lib/stageVersion.js's
// stagePayloads) and `modules` is the body of the Save, `{ [moduleId]: { fields?, layout?, ... } }`.

import { moduleUnits } from '../web/lib/stageVersion.js'

const FIELD_PREFIX = 'field:'

// The Fields a Save record writes, in the same units a clash is settled on (`field:<id>`,
// `custom:<title>`). A record that names Fields but carries no layout is read as writing just those.
function writtenUnits(record) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {}
  const layout = Array.isArray(record?.layout) ? record.layout : Object.keys(fields).map((field) => ({ field }))
  const { units, order } = moduleUnits({
    fields,
    layout: layout.map((entry) => (entry?.custom ? { custom: { ...entry.custom, value: entry.custom.value ?? fields[entry.custom.id] } } : entry)),
  })
  return { units, order }
}

function label(moduleId, key, unit) {
  return key.startsWith(FIELD_PREFIX) ? `${moduleId}.${key.slice(FIELD_PREFIX.length)}` : `${moduleId}.${JSON.stringify(unit.title ?? key.slice('custom:'.length))}`
}

const isEmpty = (value) => (Array.isArray(value) ? value.length === 0 : String(value ?? '').trim() === '')

// Every Field the Save writes whose saved content differs from what it writes. A Module that has
// no saved payload yet has nothing to differ from.
function changedFields(current, modules, { onlyHoldingContent, includeNew = false }) {
  const named = []
  for (const [moduleId, record] of Object.entries(modules ?? {})) {
    if (!current?.[moduleId] && !includeNew) continue
    const saved = current?.[moduleId] ? moduleUnits(current[moduleId]).units : new Map()
    const { units, order } = writtenUnits(record)
    for (const key of order) {
      const unit = units.get(key)
      const before = saved.get(key)
      if (includeNew) {
        // #307: a Field the Save puts content in that the stage does not hold yet counts as written too.
        if (isEmpty(unit.value)) continue
        if (before && JSON.stringify(before.value) === JSON.stringify(unit.value)) continue
        named.push(label(moduleId, key, unit))
        continue
      }
      if (!before) continue
      if (JSON.stringify(before.value) === JSON.stringify(unit.value)) continue
      if (onlyHoldingContent && isEmpty(before.value)) continue
      named.push(label(moduleId, key, unit))
    }
  }
  return named
}

// The Fields in the Save that the saved stage holds differently: what the refusal of a stale
// version names.
export function differingFields(current, modules) {
  return changedFields(current, modules, { onlyHoldingContent: false })
}

// The Fields a versionless Save overwrote: those that held content and now hold something else.
export function overwrittenFields(current, modules) {
  return changedFields(current, modules, { onlyHoldingContent: true })
}

// #307 (ADR-0067): the Fields a Save actually writes: those it puts content in that the saved stage does not hold, or holds differently.
// An outside agent sends whole module records, so this is what tells a redraft from a Field it merely carried along; only the Fields
// written here get a fresh `fields` record in the decisions log (a Field left alone is not "drafted again", so it stays Out of date).
export function writtenFields(current, modules) {
  return changedFields(current, modules, { onlyHoldingContent: false, includeNew: true })
}
