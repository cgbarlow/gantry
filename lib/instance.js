import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { loadDefinition } from './definition.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// Strips inline markdown formatting from a heading so it can be matched
// against a field's plain-text title (e.g. "## **Business driver**").
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

function instanceDir(instancesDir, slug) {
  return join(instancesDir, slug)
}

function modulePath(instancesDir, slug, moduleId) {
  return join(instanceDir(instancesDir, slug), 'modules', `${moduleId}.md`)
}

function renderModuleFile(moduleSpec, { status = 'draft', owner = '' } = {}) {
  const frontmatter = stringifyYAML({ module: moduleSpec.id, status, owner }).trimEnd()
  const sections = moduleSpec.fields
    .map((field) => `## ${field.title}\n\n`)
    .join('\n')
  return `---\n${frontmatter}\n---\n\n${sections}`
}

/**
 * `gantry new <definitionId> <slug>`: creates instances/<slug>/instance.yaml
 * plus one blank module file per module in the definition's first stage.
 */
export function createInstance(definitionId, slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definition = loadDefinition(definitionId, { definitionsDir: options.definitionsDir })
  const firstStage = definition.stages[0]
  if (!firstStage) {
    throw new Error(`Definition "${definitionId}" has no stages`)
  }

  const dir = instanceDir(instancesDir, slug)
  if (existsSync(dir)) {
    throw new Error(`Instance "${slug}" already exists at ${dir}`)
  }
  mkdirSync(join(dir, 'modules'), { recursive: true })

  writeFileSync(
    join(dir, 'instance.yaml'),
    stringifyYAML({ definition: definitionId, slug, stage: firstStage.id })
  )

  for (const moduleId of firstStage.modules) {
    const moduleSpec = definition.modules.get(moduleId)
    writeFileSync(
      modulePath(instancesDir, slug, moduleId),
      renderModuleFile(moduleSpec, { owner: options.owner ?? '' })
    )
  }

  return { slug, definitionId, stage: firstStage.id, modules: firstStage.modules }
}

export function readInstance(slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read instance "${slug}" at ${path}: ${err.message}`)
  }
  return parseYAML(text)
}

/**
 * Parse a module instance file's frontmatter and field sections into
 * { module, status, owner, fields: { [fieldId]: string | string[] }, warnings },
 * keyed against `moduleSpec` (from loadDefinition) by matching each
 * `## <field.title>` heading (markdown formatting in the heading is
 * stripped before matching). Fields whose heading isn't found are left
 * out of the result (not defaulted), so callers can distinguish "absent"
 * from "empty".
 *
 * A heading that matches no field, or a duplicate heading (later occurrence
 * wins), is a warning in `warnings` by default. With `{ strict: true }` —
 * used by `gantry check`'s hard-error path — those same two conditions
 * throw instead, so a gate can't pass on data the parser wasn't confident
 * about.
 */
export function parseModuleFile(text, moduleSpec, options = {}) {
  const strict = options.strict ?? false
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    throw new Error(`Module file for "${moduleSpec.id}" is missing YAML frontmatter`)
  }
  const frontmatter = parseYAML(match[1]) ?? {}
  const body = text.slice(match[0].length)

  const fieldTitles = new Set(moduleSpec.fields.map((field) => field.title))
  const warnings = []
  const sections = new Map()
  const headingRe = /^##[ \t]+(.+?)\s*$/gm
  const headings = [...body.matchAll(headingRe)]
  for (let i = 0; i < headings.length; i++) {
    const rawTitle = headings[i][1]
    const title = normalizeHeadingText(rawTitle)
    const start = headings[i].index + headings[i][0].length
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length
    const value = body.slice(start, end).trim()

    if (!fieldTitles.has(title)) {
      const message = `Module "${moduleSpec.id}": heading "${rawTitle}" does not match any field`
      if (strict) throw new Error(message)
      warnings.push(message)
    }
    if (sections.has(title)) {
      const message = `Module "${moduleSpec.id}": duplicate heading "${rawTitle}" — later occurrence wins`
      if (strict) throw new Error(message)
      warnings.push(message)
    }

    sections.set(title, value)
  }

  const fields = {}
  for (const field of moduleSpec.fields) {
    const raw = sections.get(field.title)
    if (raw === undefined) continue
    if (field.type === 'list') {
      // A bullet's wrapped continuation lines (no leading "- ") fold onto
      // the item they follow, rather than being silently dropped.
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
      fields[field.id] = items
    } else {
      fields[field.id] = raw
    }
  }

  return {
    module: frontmatter.module,
    status: frontmatter.status,
    owner: frontmatter.owner,
    fields,
    warnings,
  }
}

/**
 * Writes a module instance file in the same format `createInstance`/
 * `parseModuleFile` produce and read: frontmatter (`module`, `status`,
 * `owner`) followed by one `## <field.title>` section per field, in
 * `moduleSpec` order. `data.fields` is keyed by field id, as returned by
 * `parseModuleFile`/`readModule` — this is the exact inverse of those.
 */
export function writeModule(definition, slug, moduleId, data, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }

  const frontmatter = stringifyYAML({
    module: moduleId,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
  }).trimEnd()

  const sections = moduleSpec.fields
    .map((field) => {
      const value = data.fields?.[field.id]
      const body =
        field.type === 'list'
          ? (Array.isArray(value) ? value : [])
              .map((item) => item.trim())
              .filter((item) => item !== '')
              .map((item) => `- ${item}`)
              .join('\n')
          : value ?? ''
      return `## ${field.title}\n\n${body}\n`
    })
    .join('\n')

  const path = modulePath(instancesDir, slug, moduleId)
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${sections}`)
  return { module: moduleId, path }
}

export function readModule(definition, slug, moduleId, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }
  const path = modulePath(instancesDir, slug, moduleId)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read module "${moduleId}" for instance "${slug}" at ${path}: ${err.message}`)
  }
  return parseModuleFile(text, moduleSpec)
}
