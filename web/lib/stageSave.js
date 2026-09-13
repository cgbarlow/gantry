// Centralised Save (WI #376): what a module's save payload is, and whether it
// differs from what's saved. Kept pure so the dirty rule is tested without a
// browser; the module editor (web/app.js) owns when these run.

// The payload the module writer takes — `{ status, owner, fields, layout }` —
// with fields and custom sections in displayed order. `valueOf(field)` gives a
// field's live value (its editor text or list rows); `undefined` falls back to
// the value the field was loaded or last restored with.
export function modulePayload(mod, valueOf = () => undefined) {
  const fields = {}
  const layout = []
  for (const field of mod.fields) {
    const live = valueOf(field)
    const value = live === undefined ? (field.value ?? (field.type === 'list' ? [] : '')) : live
    fields[field.id] = value
    layout.push(
      field.custom ? { custom: { id: field.id, title: field.title, type: field.type, value } } : { field: field.id }
    )
  }
  return { status: mod.status, owner: mod.owner, fields, layout }
}

// Normalised the way saving normalises (list items trimmed, blank rows dropped;
// line endings as the editor holds them), so two payloads compare equal exactly
// when they would save the same content.
function normaliseValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== '')
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

// A comparable fingerprint of a payload. Custom sections are compared by
// title, type and content, not by their client-side ids.
export function payloadKey(payload) {
  return JSON.stringify({
    status: payload.status ?? null,
    owner: payload.owner ?? null,
    fields: Object.entries(payload.fields).map(([id, value]) => [id, normaliseValue(value)]),
    layout: payload.layout.map((entry) =>
      entry.custom
        ? { custom: { title: entry.custom.title, type: entry.custom.type, value: normaliseValue(entry.custom.value) } }
        : entry
    ),
  })
}

// The module's field list as it was saved — what Discard puts back, including
// sections and lists inserted or removed since.
export function savedFields(mod, saved) {
  const byId = new Map(mod.fields.map((field) => [field.id, field]))
  return saved.layout
    .map((entry) => {
      if (!entry.custom) {
        const field = byId.get(entry.field)
        return field && { ...field, value: saved.fields[entry.field] }
      }
      const { id, title, type, value } = entry.custom
      return { required: false, guidance: null, example: null, ...byId.get(id), id, title, type, value, custom: true }
    })
    .filter(Boolean)
}

// A module card's line after a save, from that module's completeness.
export function saveStatusLine(statusModule) {
  return statusModule?.complete
    ? 'Saved — complete.'
    : `Saved — outstanding: ${statusModule?.outstanding?.join(', ') || 'none'}`
}
