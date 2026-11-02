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
function changedFields(current, modules, { onlyHoldingContent }) {
  const named = []
  for (const [moduleId, record] of Object.entries(modules ?? {})) {
    if (!current?.[moduleId]) continue
    const saved = moduleUnits(current[moduleId]).units
    const { units, order } = writtenUnits(record)
    for (const key of order) {
      const unit = units.get(key)
      const before = saved.get(key)
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
