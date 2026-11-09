// #362: "Move to v<N>" in an Instance's Settings — moving an Instance onto the latest published version of its Definition.
//
// Everything here is worked out from the two versions' structures, with no per-version script, so the move works for any Definition:
//
//   * Fields the newer version no longer has. Their sections leave the Instance's Module files on the move (the only thing the move
//     converts), and the dialog lists the ones that had content, with their Module.
//   * Fields new in it, and Fields a Gate on a Stage the Instance has not passed yet now asks for. Shown only, so the architect knows
//     what the next Gate will want.
//   * Fields whose type changed (a list that became Markdown, say). Shown only: Gantry leaves the content as it is.
//
// Then the move itself is one change: the Module files without the dropped Fields, a line in the current Stage's decisions log, and
// `definitionVersion: <N>` in instance.yaml. A Provider workspace writes them as one commit and a server workspace as one save
// (lib/definitionMove.js); a Local workspace's browser writes them into its folder with `writeAllOrRestore`, which puts back what it
// wrote if a later write fails. Either way a failed move leaves the Instance as it was.
//
// Shared by the server and a Local workspace's browser, so this has no DOM, no network and no `node:` import.
// tests/definitionVersionMove.test.js drives all of it.
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { applyDecisionsDelta, decisionsLogPath, parseDecisionsLog, serializeDecisionsLog } from './decisionsLog.js'
import { normalizeHeadingText } from './localInstanceFiles.js'

// ---------- what changes between two versions ----------

// A structure is a loaded Definition (`modules` a Map) or its projection (`modules` an array); either way Gantry's own mounted
// standard Modules (#283) are Gantry's, not the Definition's, so they never count as a change.
function modulesOf(structure) {
  const modules = structure?.modules instanceof Map ? [...structure.modules.values()] : structure?.modules ?? []
  return modules.filter((m) => m && !m.standard)
}

/** Every Field of a structure, keyed `module.field`, in the Definition's order. */
function fieldsOf(structure) {
  const fields = new Map()
  for (const module of modulesOf(structure)) {
    for (const f of module.fields ?? []) {
      fields.set(`${module.id}.${f.id}`, { moduleId: module.id, moduleTitle: module.title ?? module.id, fieldId: f.id, fieldTitle: f.title ?? f.id, field: f })
    }
  }
  return fields
}

const describe = ({ moduleId, moduleTitle, fieldId, fieldTitle }) => ({ moduleId, moduleTitle, fieldId, fieldTitle })

// A select that took `multiple` stores a list where it stored one value, so it is a change of type too.
const typeLabel = (f) => (f.type === 'select' && f.multiple === true ? 'select (multiple)' : f.type)

// lib/status.js's rule: a Field is required at a Gate when it is `required`, or its `required-at` names the Gate.
const requiredAt = (f, gate) => f?.required === true || (Array.isArray(f?.requiredAt) && f.requiredAt.includes(gate))

/**
 * The Fields a Gate asks for, as `module.field` keys, the way lib/status.js judges it: each required Field of the Stage's Modules,
 * and each Artefact for the Gate that can pass it — a bare `module.field` always, a `module.field?` only when the Field is required
 * at the Gate itself, and a whole Module's Fields that are required at the Gate.
 */
function gateRequiredKeys(structure, stage) {
  const fields = fieldsOf(structure)
  const keys = new Set()
  const moduleFields = (moduleId) => [...fields.values()].filter((f) => f.moduleId === moduleId)
  for (const moduleId of stage.modules ?? []) {
    for (const f of moduleFields(moduleId)) if (requiredAt(f.field, stage.gate)) keys.add(`${f.moduleId}.${f.fieldId}`)
  }
  for (const artefact of structure.artefacts ?? []) {
    if (artefact.gate !== stage.gate || artefact.satisfiesGate === false) continue
    for (const raw of artefact.requires ?? []) {
      const optional = raw.endsWith('?')
      const ref = optional ? raw.slice(0, -1) : raw
      const dot = ref.indexOf('.')
      if (dot === -1) {
        for (const f of moduleFields(ref)) if (requiredAt(f.field, stage.gate)) keys.add(`${f.moduleId}.${f.fieldId}`)
        continue
      }
      if (!fields.has(ref)) continue
      if (!optional || requiredAt(fields.get(ref).field, stage.gate)) keys.add(ref)
    }
  }
  return keys
}

/** The Stages the Instance has not passed yet: its current one and every one after it. All of them when the current one is unknown. */
function stagesAhead(structure, stageId) {
  const stages = structure?.stages ?? []
  const at = stages.findIndex((s) => s.id === stageId)
  return at === -1 ? stages : stages.slice(at)
}

/**
 * What changes from `from` to `to` for an Instance on `stageId`: `{ removed, added, newlyRequired, typeChanged }`, each a list of
 * `{ moduleId, moduleTitle, fieldId, fieldTitle }` in the Definition's order. `added` carries `requiredAt`, the Stages ahead whose Gate
 * asks for the new Field; `newlyRequired` (Fields both versions have) carries `stages`, the Stages ahead whose Gate asks for it now
 * and did not before; `typeChanged` carries `fromType` and `toType`. Titles are the version that has the Field: `from` for a removed
 * one, `to` otherwise.
 */
export function definitionVersionChanges(from, to, { stageId } = {}) {
  const before = fieldsOf(from)
  const after = fieldsOf(to)
  const ahead = stagesAhead(to, stageId).map((stage) => {
    const was = (from?.stages ?? []).find((s) => s.id === stage.id)
    return { stage: { id: stage.id, title: stage.title ?? stage.id }, now: gateRequiredKeys(to, stage), was: was ? gateRequiredKeys(from, was) : new Set() }
  })
  const removed = [...before.entries()].filter(([key]) => !after.has(key)).map(([, f]) => describe(f))
  const added = [...after.entries()]
    .filter(([key]) => !before.has(key))
    .map(([key, f]) => ({ ...describe(f), requiredAt: ahead.filter((a) => a.now.has(key)).map((a) => a.stage) }))
  const newlyRequired = [...after.entries()]
    .filter(([key]) => before.has(key))
    .map(([key, f]) => ({ ...describe(f), stages: ahead.filter((a) => a.now.has(key) && !a.was.has(key)).map((a) => a.stage) }))
    .filter((f) => f.stages.length > 0)
  const typeChanged = [...after.entries()]
    .filter(([key, f]) => before.has(key) && typeLabel(before.get(key).field) !== typeLabel(f.field))
    .map(([key, f]) => ({ ...describe(f), fromType: typeLabel(before.get(key).field), toType: typeLabel(f.field) }))
  return { removed, added, newlyRequired, typeChanged }
}

/** The Modules whose files the move has to read: those with a Field the newer version no longer has. */
export function removedFieldModuleIds(from, to) {
  return [...new Set(definitionVersionChanges(from, to).removed.map((f) => f.moduleId))]
}

// ---------- a Field's section in a Module file ----------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// lib/instance.js's parseModuleFile reads a Field from its `## <title>` heading to the next `##` heading; this finds the same sections,
// with offsets into the whole file so a section can be cut out and everything around it kept byte for byte.
function sectionsOf(text) {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return []
  const offset = match[0].length
  const headings = [...text.slice(offset).matchAll(/^##(?:[ \t]+(.*))?[ \t]*$/gm)]
  return headings.map((h, i) => {
    const start = offset + h.index
    const end = i + 1 < headings.length ? offset + headings[i + 1].index : text.length
    return { title: normalizeHeadingText(h[1] ?? ''), start, end, value: text.slice(start + h[0].length, end).trim() }
  })
}

/** The content of the Field titled `title` in a Module file (`''` for an empty section), or `null` when the file has no such section. */
export function fieldSectionContent(text, title) {
  const found = sectionsOf(text).filter((s) => s.title === title)
  return found.length ? found[found.length - 1].value : null
}

/**
 * The Module file without the sections titled `titles`. Each goes from its heading to the next one, so the text around it is
 * unchanged; the file's last section goes with the blank lines before it, so the file still ends with one newline.
 */
export function withoutFieldSections(text, titles) {
  const sections = sectionsOf(text)
  const drop = sections.filter((s) => titles.includes(s.title))
  if (drop.length === 0) return text
  let out = text.slice(0, sections[0].start)
  for (const s of sections) if (!drop.includes(s)) out += text.slice(s.start, s.end)
  return drop.includes(sections[sections.length - 1]) ? `${out.trimEnd()}\n` : out
}

// ---------- the move ----------

/**
 * The move from `from` to `to` for an Instance on `stageId`, given its Module files (`moduleFiles`, `{ [moduleId]: text | null }`, at
 * least those `removedFieldModuleIds` names): `{ definition, from, to, stageId, changes, removed, files }`. `removed` is the Fields
 * whose content the move takes out (an empty section is cut too, but there is nothing in it to name); `files` is each Module file
 * that changes, as `{ path, text }` relative to the Instance's folder. A heading the newer version gives to another Field of the same
 * Module is that Field's, so it stays.
 */
export function planDefinitionMove({ from, to, stageId, moduleFiles = {} }) {
  const changes = definitionVersionChanges(from, to, { stageId })
  const toTitles = new Map(modulesOf(to).map((m) => [m.id, new Set((m.fields ?? []).map((f) => f.title))]))
  const removed = []
  const files = []
  for (const moduleId of [...new Set(changes.removed.map((f) => f.moduleId))]) {
    const text = moduleFiles[moduleId]
    if (typeof text !== 'string') continue
    const stillUsed = toTitles.get(moduleId) ?? new Set()
    const present = changes.removed.filter((f) => f.moduleId === moduleId && !stillUsed.has(f.fieldTitle) && fieldSectionContent(text, f.fieldTitle) !== null)
    if (present.length === 0) continue
    removed.push(...present.filter((f) => fieldSectionContent(text, f.fieldTitle) !== ''))
    const next = withoutFieldSections(text, present.map((f) => f.fieldTitle))
    if (next !== text) files.push({ path: `modules/${moduleId}.md`, text: next })
  }
  return { definition: to.id, from: from.version, to: to.version, stageId, changes, removed, files }
}

/** The version to offer a move to: the latest published one when it is newer than the Instance's, else `null` (no drafts, no moving back). */
export function definitionMoveTarget(currentVersion, latestPublished) {
  return Number.isInteger(latestPublished) && latestPublished > (currentVersion ?? 1) ? latestPublished : null
}

/** The move in a sentence, for the decisions log and (with the Instance named) the commit message. */
export function definitionMoveSummary(plan) {
  const removed = plan.removed.map((f) => `${f.fieldTitle} (${f.moduleTitle})`)
  return `Moved from v${plan.from} to v${plan.to}. ${removed.length ? `Removed: ${removed.join(', ')}.` : 'No Field had content to remove.'}`
}

export const definitionMoveCommitMessage = (slug, plan) => `Instance "${slug}": ${definitionMoveSummary(plan)}`

/** The current Stage's decisions log line for the move (kind `definition-move`), naming the Fields removed. */
export function definitionMoveEntry(plan, { at = new Date().toISOString(), who } = {}) {
  return {
    id: `definition-move-v${plan.from}-v${plan.to}-${String(at).replace(/\D/g, '').slice(0, 14)}`,
    at,
    kind: 'definition-move',
    ...(who ? { who } : {}),
    definition: plan.definition,
    from: plan.from,
    to: plan.to,
    removed: plan.removed.map((f) => ({ module: f.moduleId, field: f.fieldId, title: f.fieldTitle, moduleTitle: f.moduleTitle })),
    note: definitionMoveSummary(plan),
  }
}

// lib/instance.js's canonical instance.yaml (recursively key-sorted), for a record with no version line to change.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  return value
}

/** instance.yaml set to `version`: its one `definitionVersion:` line changed and every other byte kept, or written canonically when it has none. */
export function withDefinitionVersion(instanceYaml, version) {
  const lines = [...String(instanceYaml ?? '').matchAll(/^definitionVersion:[ \t]*\d+[ \t]*$/gm)]
  if (lines.length === 1) return instanceYaml.replace(/^definitionVersion:[ \t]*\d+[ \t]*$/m, `definitionVersion: ${version}`)
  return stringifyYAML(canonical({ ...(parseYAML(instanceYaml ?? '') ?? {}), definitionVersion: version }))
}

/**
 * Every file the move writes, as `[{ path, text }]` relative to the Instance's folder: the changed Module files, the current Stage's
 * decisions log with `entry` appended (`logText` is the log as committed, or `null` for none yet) and, last, instance.yaml on the new
 * version — so a writer that cannot write them all at once changes the version only when the rest is in.
 */
export function definitionMoveWrites(plan, { instanceYaml, logText, entry }) {
  const log = applyDecisionsDelta(parseDecisionsLog(logText ?? null, plan.stageId), { entries: [entry] }, plan.stageId)
  return [
    ...plan.files,
    { path: decisionsLogPath(plan.stageId), text: serializeDecisionsLog(log) },
    { path: 'instance.yaml', text: withDefinitionVersion(instanceYaml, plan.to) },
  ]
}

/**
 * Writes `files` in turn through `read(path)` (text or `null`), `write(path, text)` and `remove(path)`, for a folder that cannot
 * write several files at once. Every file is read before any is written; if a write fails, the files already written go back to
 * what they held (a file the move created is removed) and the error is thrown on, so the Instance is left as it was.
 */
export async function writeAllOrRestore(files, { read, write, remove }) {
  const before = []
  for (const { path } of files) before.push(await read(path))
  const written = []
  try {
    for (const [i, { path, text }] of files.entries()) {
      await write(path, text)
      written.push(i)
    }
  } catch (err) {
    for (const i of written.reverse()) {
      try {
        if (before[i] === null) await remove(files[i].path)
        else await write(files[i].path, before[i])
      } catch {
        // Putting one file back failed too; the rest are still put back, and the first error is the one reported.
      }
    }
    throw err
  }
}

// ---------- what the dialog shows ----------

/**
 * What the dialog shows for a move: `{ available: true, definition, from, to, removed, added, newlyRequired, typeChanged, changelog,
 * blocked }`, the same from `GET /api/instance/definition-move` and from a Local workspace's own reading of its folder. `blocked` is
 * the sentence saying why the move must wait, or `null`.
 */
export function definitionMoveView(plan, { changelog = null, blocked = null } = {}) {
  return {
    available: true,
    definition: plan.definition,
    from: plan.from,
    to: plan.to,
    removed: plan.removed,
    added: plan.changes.added,
    newlyRequired: plan.changes.newlyRequired,
    typeChanged: plan.changes.typeChanged,
    changelog,
    blocked,
  }
}

/** The Definition's own CHANGELOG section for `version` (`## v<N>` up to the next `## ` heading), or `null` when it has none. */
export function changelogSection(changelog, version) {
  if (typeof changelog !== 'string') return null
  const start = changelog.search(new RegExp(`^## v${version}\\b.*$`, 'm'))
  if (start === -1) return null
  const rest = changelog.slice(start)
  const next = rest.slice(1).search(/^## /m)
  return (next === -1 ? rest : rest.slice(0, next + 1)).trim()
}

/** Why the move waits while the current Stage awaits approval on a Provider workspace (its Pull Request is open). */
export function definitionMoveBlockedReason(stage, version) {
  return `${stage?.title ?? stage?.id ?? 'This Stage'} is awaiting approval, so this Instance can't move to v${version} yet: the move would change content its Pull Request asks the Owner to approve. Move it once the Pull Request is approved or closed.`
}
