// Field-shape predicates (#80): the one place per twin that decides whether a Definition
// field's stored value is single-line text or several bullet-list values. Before this, "is
// this field multi-valued?" was re-asked as `field.type === 'list'` at every call site that
// needed to know a field's empty value or how to parse/serialise its section body. Adding
// field types (#81 onward) would have meant editing every one of those sites by hand; instead
// they all go through here.
//
// This is the server-side twin. web/lib/fieldShape.js is its Local-Workspace counterpart —
// the two must stay behaviourally identical, mirroring the existing deliberate twinning
// between lib/instance.js and web/lib/localInstanceFiles.js.

// #83 (ADR-0044): a select with `multiple: true` is a variation within `select`, not a second
// type name — it stores its several values as bullets, byte-identical to how `list` already
// writes, so it needs no new parse/serialise branch here, only this one extra shape check.
export function isMultiValuedField(field) {
  return field.type === 'list' || (field.type === 'select' && field.multiple === true)
}

export function emptyFieldValue(field) {
  return isMultiValuedField(field) ? [] : ''
}

// Parses a field's raw section body into the value shape its type stores: a multi-valued
// field becomes string[], everything else stays the raw string. A wrapped continuation line
// (no leading "- ") folds onto the item it follows — the same rule the parser already applies
// to preserved custom list fields (#132).
export function parseFieldBody(field, raw) {
  if (!isMultiValuedField(field)) return raw
  const items = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('- ')) {
      items.push(line.slice(2).trim())
    } else if (items.length > 0) {
      items[items.length - 1] += ` ${line}`
    }
  }
  return items
}

// Serialises a field's value back into its section body: a multi-valued field's several
// values become bullets (byte-identical to how a custom list field already writes),
// everything else is the string as-is (or '' when absent).
export function serialiseFieldBody(field, value) {
  if (!isMultiValuedField(field)) return value ?? ''
  return (Array.isArray(value) ? value : [])
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => `- ${item}`)
    .join('\n')
}
