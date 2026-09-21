// Browser-side re-implementation of the pure text-rendering/parsing helpers
// `lib/instance.js` uses for an instance's on-disk files: the canonical
// `instance.yaml` serializer, the blank `modules/<id>.md` template, and (WI
// #297, A6 — the module editor's local-workspace read/write path) the
// read-side counterparts — parsing `instance.yaml` and a saved module file
// back into structured data, and re-rendering a module file from the
// editor's save payload. A **local workspace** (ADR-0029) reads and writes
// these files straight through a `FileSystemDirectoryHandle` rather than
// server-side, so this needs byte-identical behaviour without importing
// `lib/instance.js` (which is server-only — it pulls in `node:fs`, the
// Azure DevOps client, etc.).
//
// Kept deliberately small and in lock-step with `lib/instance.js`:
//   - `renderInstanceYaml` mirrors `stringifyInstanceYAML` — canonical
//     (recursively key-sorted) YAML, so two writers touching disjoint fields
//     produce mergeable bytes (see `lib/instance.js`'s own long comment).
//   - `renderModuleFile` mirrors `renderModuleFile` verbatim: `---`-fenced
//     `module` / `status` / `owner` frontmatter, the module title at `#`,
//     one empty `## <field title>` section per field.
//   - `parseInstanceYaml`/`withInstanceStage` mirror the plain `parseYAML`
//     read `lib/instance.js`'s `readInstance` does over `instance.yaml`, and
//     the canonical re-serialization stage advancement writes back.
//   - `parseLocalModuleFile` is a verbatim port of `lib/instance.js`'s
//     `parseModuleFile` — same frontmatter/heading/custom-field/list parsing.
//   - `renderLocalModuleInstanceFile` is a verbatim port of
//     `lib/instance.js`'s (private) `renderModuleInstanceFile` — the
//     save-payload writer (`data.layout`-aware), distinct from the
//     blank-template `renderModuleFile` above.
//   - `buildLocalModuleEntry` is a verbatim port of `lib/server.js`'s
//     (private) `buildModuleEntry` — turns a parsed module's data into the
//     `{ id, title, purpose, status, owner, fields }` shape the editor's
//     `GET /api/instance` contract already returns, so `ModuleEditorPage`
//     can consume a local instance unchanged.
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { parseFieldBody, serialiseFieldBody, emptyFieldValue } from './fieldShape.js'

// Recursively sort every plain object's keys — the exact shape of
// `lib/instance.js`'s `canonicalizeForSerialization`.
function canonicalizeForSerialization(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSerialization)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeForSerialization(value[key])
    }
    return sorted
  }
  return value
}

/**
 * The text to write at `gantry-workspace/<slug>/instance.yaml` for a new
 * local-workspace instance — the same fields `createInstance` records
 * (`definition`, `slug`, `stage` = first stage id, `assignee`,
 * `definitionVersion`), serialized canonically.
 */
export function renderInstanceYaml({ definition, slug, stage, assignee, definitionVersion }) {
  return stringifyYAML(
    canonicalizeForSerialization({
      definition,
      slug,
      stage,
      assignee: assignee ?? '',
      definitionVersion,
    })
  )
}

/**
 * A blank module file for `moduleSpec` (`{ id, title, fields: [{ title }] }`)
 * — verbatim port of `lib/instance.js`'s `renderModuleFile`.
 */
export function renderModuleFile(moduleSpec, { status = 'draft', owner = '' } = {}) {
  const frontmatter = stringifyYAML({ module: moduleSpec.id, status, owner }).trimEnd()
  const sections = moduleSpec.fields.map((field) => `## ${field.title}\n\n`).join('\n')
  return `---\n${frontmatter}\n---\n\n# ${moduleSpec.title}\n\n${sections}`
}

// ---------------------------------------------------------------------------
// instance.yaml — read side + stage-advancement rewrite
// ---------------------------------------------------------------------------

/** Parse `instance.yaml` text into its plain record — the same bare `parseYAML` `lib/instance.js`'s `readInstance` does (no default-assignee/merge-conflict handling; a local workspace instance always has both). */
export function parseInstanceYaml(text) {
  return parseYAML(text) ?? {}
}

/**
 * The bytes to write back to `instance.yaml` after Stage advancement
 * (step 7, WI #297) — the existing record with `stage` replaced, canonically
 * re-serialized so a concurrent disjoint-field writer's own edits stay
 * mergeable (mirrors `renderInstanceYaml`'s own canonicalization).
 */
export function withInstanceStage(record, stage) {
  return stringifyYAML(canonicalizeForSerialization({ ...record, stage }))
}

/**
 * The bytes to write back to `instance.yaml` after editing the instance's
 * own stored `assignee` from a local-workspace Instance Settings screen (WI
 * #303) — the existing record with `assignee` replaced, canonically
 * re-serialized so a concurrent disjoint-field writer's own edits stay
 * mergeable. Same read-modify-write shape as `withInstanceStage` above.
 */
export function withInstanceAssignee(record, assignee) {
  return stringifyYAML(canonicalizeForSerialization({ ...record, assignee }))
}

// ---------------------------------------------------------------------------
// Module files — read side (parse) + save-payload writer
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function normalizeHeadingText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim()
}

function isAllBullets(body) {
  const lines = body.split('\n').filter((line) => line.trim() !== '')
  return lines.every((line) => line.trim().startsWith('- '))
}

function parseListContent(body) {
  const items = []
  for (const rawLine of body.split('\n')) {
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

function uniqueCustomFieldId(title, usedIds) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  let candidate = `custom:${slug}`
  let n = 2
  while (usedIds.has(candidate)) {
    candidate = `custom:${slug}-${n}`
    n++
  }
  usedIds.add(candidate)
  return candidate
}

/**
 * Verbatim port of `lib/instance.js`'s `parseModuleFile` — parse a module
 * instance file's frontmatter and field sections into
 * `{ module, status, owner, fields, customFields, layout, warnings }`, keyed
 * against `moduleSpec` (the definition's module entry) the same way. See
 * that function's own doc comment for the full field-by-field contract
 * (custom sections, list-typed fields, duplicate-heading warnings).
 */
export function parseLocalModuleFile(text, moduleSpec, options = {}) {
  const strict = options.strict ?? false
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    throw new Error(`Module file for "${moduleSpec.id}" is missing YAML frontmatter`)
  }
  const frontmatter = parseYAML(match[1]) ?? {}
  const body = text.slice(match[0].length)

  const fieldsById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const warnings = []
  const sections = new Map()
  const layout = []
  const customFields = []
  const usedCustomIds = new Set()
  const headingRe = /^##(?:[ \t]+(.*))?[ \t]*$/gm
  const headings = [...body.matchAll(headingRe)]
  for (let i = 0; i < headings.length; i++) {
    const rawTitle = headings[i][1] ?? ''
    const title = normalizeHeadingText(rawTitle)
    const start = headings[i].index + headings[i][0].length
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length
    const value = body.slice(start, end).trim()

    const fieldDef = [...fieldsById.values()].find((field) => field.title === title)
    if (!fieldDef) {
      const id = uniqueCustomFieldId(title, usedCustomIds)
      const rawTitleText = rawTitle.trim()
      const isList = isAllBullets(value)
      const custom = isList
        ? { id, title: rawTitleText, type: 'list', value: parseListContent(value) }
        : { id, title: rawTitleText, value }
      customFields.push(custom)
      layout.push({ custom })
      continue
    }
    if (sections.has(title)) {
      const message = `Module "${moduleSpec.id}": duplicate heading "${rawTitle}" — later occurrence wins`
      if (strict) throw new Error(message)
      warnings.push(message)
    }

    sections.set(title, value)
    layout.push({ field: fieldDef.id })
  }

  const fields = {}
  for (const field of moduleSpec.fields) {
    const raw = sections.get(field.title)
    if (raw === undefined) continue
    fields[field.id] = parseFieldBody(field, raw)
  }

  return {
    module: frontmatter.module,
    status: frontmatter.status,
    owner: frontmatter.owner,
    fields,
    customFields,
    layout,
    warnings,
  }
}

/**
 * Verbatim port of `lib/instance.js`'s (private) `renderModuleInstanceFile`
 * — the exact frontmatter+field-sections text a save (`data.layout`-aware)
 * produces, byte-identical to the server-side writer so a file saved
 * locally and one saved server-side can never drift.
 */
export function renderLocalModuleInstanceFile(moduleId, moduleSpec, data) {
  const frontmatter = stringifyYAML({
    module: moduleId,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
  }).trimEnd()

  const fieldsById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const sectionText = (title, body) => `## ${title}\n\n${body}\n`
  const definedFieldBody = (field) => serialiseFieldBody(field, data.fields?.[field.id])

  const sections = []
  const laidOut = new Set()
  for (const entry of data.layout ?? []) {
    if (entry.field !== undefined) {
      const field = fieldsById.get(entry.field)
      if (!field) continue
      sections.push(sectionText(field.title, definedFieldBody(field)))
      laidOut.add(field.id)
    } else if (entry.custom) {
      const body =
        entry.custom.type === 'list'
          ? (Array.isArray(entry.custom.value) ? entry.custom.value : [])
              .map((item) => item.trim())
              .filter((item) => item !== '')
              .map((item) => `- ${item}`)
              .join('\n')
          : entry.custom.value ?? ''
      if (entry.custom.type === 'list' && body === '') continue
      sections.push(sectionText(entry.custom.title ?? '', body))
    }
  }
  for (const field of moduleSpec.fields) {
    if (!laidOut.has(field.id)) {
      sections.push(sectionText(field.title, definedFieldBody(field)))
    }
  }

  return `---\n${frontmatter}\n---\n\n# ${moduleSpec.title}\n\n${sections.join('\n')}`
}

function fieldValue(field, data) {
  const raw = data.fields[field.id]
  if (raw !== undefined) return raw
  return emptyFieldValue(field)
}

/**
 * Verbatim port of `lib/server.js`'s (private) `buildModuleEntry` — turns a
 * parsed module's data (`parseLocalModuleFile`'s return, or the blank
 * `{ status: 'draft', owner: '', fields: {} }` when no file exists yet) into
 * the `{ id, title, purpose, status, owner, fields }` shape `GET
 * /api/instance` already returns, so `ModuleEditorPage` renders a local
 * instance's modules with no shape difference from a server-backed one.
 */
export function buildLocalModuleEntry(moduleSpec, stage, data, exampleData) {
  const definedById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const entryForDefined = (field) => ({
    id: field.id,
    title: field.title,
    type: field.type,
    required: Boolean(field.required) || Boolean(field.requiredAt?.includes(stage.gate)),
    guidance: field.guidance,
    value: fieldValue(field, data),
    example: exampleData ? fieldValue(field, exampleData) : null,
  })

  const entries = []
  const emitted = new Set()
  for (const layoutEntry of data.layout ?? []) {
    if (layoutEntry.field !== undefined) {
      const field = definedById.get(layoutEntry.field)
      if (!field) continue
      entries.push(entryForDefined(field))
      emitted.add(field.id)
    } else if (layoutEntry.custom) {
      entries.push({
        id: layoutEntry.custom.id,
        title: layoutEntry.custom.title,
        type: layoutEntry.custom.type === 'list' ? 'list' : 'markdown',
        required: false,
        guidance: null,
        value: layoutEntry.custom.value ?? (layoutEntry.custom.type === 'list' ? [] : ''),
        example: null,
        custom: true,
      })
    }
  }
  for (const field of moduleSpec.fields) {
    if (!emitted.has(field.id)) entries.push(entryForDefined(field))
  }

  return {
    id: moduleSpec.id,
    title: moduleSpec.title,
    purpose: moduleSpec.purpose,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
    fields: entries,
  }
}
