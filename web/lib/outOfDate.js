// #297 (map #238, decided in #249; docs/adr/0064 and 0068): which Fields are **Out of date** because a Source document they drew on has since changed.
//
// A Source document has changed when it has been
//   * removed          (`removedAt` in sources/manifest.yaml),
//   * replaced         (a newer document's `replaces` names it; the older one stays, marked "replaced by"), or
//   * re-extracted     (its text was read again and actually came out different: `textChangedAt`, set only when the
//                       fingerprint of the text changed, so re-reading to the very same text changes nothing).
// A new document that replaces nothing changes nothing for any Field: it is only marked **New since last interview**.
//
// #319 (docs/adr/0072): a **code repository** is read live, so it changes when its branch does. What a Field drew on from one is a set of
// files, each at the commit it was read at (the decisions log's inputs and the citations in the content name them). When a Stage opens, the
// caller has the Gantry server compare each of those files at its recorded commit with the branch head (`repositoryReadsOf` says which;
// web/lib/outOfDateLoad.js asks). Only a real change to one of them flags the Field (`code-changed`, naming the files); a new commit that
// touches nothing the Field used flags nothing. The architect answers it like any other flag: the `source-update` entry records the head
// commit they answered at, and the Field is flagged again only when one of those files changes after it.
//
// What is flagged is exactly the Fields that drew on, or cite, that document:
//   * AI-drafted Fields whose decisions-log `fields` record lists it among its inputs (ADR-0064), and
//   * any content, hand-written included, that cites it with `source:<id>` (#281).
// A Field that an earlier Field was the input of is flagged too once that earlier Field's content is no longer what the draft saw
// (the Save check taking the other side's version of a Field, ADR-0068, is the usual way): the record's input fingerprint no longer
// matches the Field's saved content.
//
// Nothing is stored for a flag. Whether a Field is flagged is worked out from the manifest, the decisions logs and the saved
// content each time, so it is the same in every workspace kind and nothing can drift. A flag clears when
//   * the Field is drafted again after the change (its record's `drafted` is at or after the change), or
//   * the architect answered for it: a decisions-log entry of kind `source-update` naming the document and the Field, made at or
//     after the change (#298 writes these when a card is answered; only the architect clears a flag). A Field flagged because an
//     earlier Field it drew on has changed is answered the same way: the entry names that earlier Field (`inputField`) and the
//     fingerprint of its text when the architect answered (`inputFingerprint`), so a later change to it flags the Field again.
//
// Pure (no DOM, no network), shared by the editor, the Interview page and, later, MCP. tests/outOfDate.test.js drives it.
import { normalizeSavedContent } from './interviewBrief.js'
import { citedSourceIds, findSourceCitations } from './sourceCitations.js'
import { fingerprintText, isRemovedSource, replacedByMap } from './sourceDocuments.js'
import { isRepositorySource, shortCommit } from './sourceRepository.js'

/** The kind of decisions-log entry that records the architect's answer for a Field that was Out of date (written by "Bring up to date", #298). */
export const SOURCE_UPDATE_KIND = 'source-update'

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()
const time = (iso) => {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? null : t
}

/** Logs given as `{ stageId: log }` or as a list of logs (each with its `stage`) become `[[stageId, log]]`. */
function logPairs(logs) {
  if (Array.isArray(logs)) return logs.filter(Boolean).map((log) => [log.stage ?? '', log])
  return Object.entries(logs ?? {}).filter(([, log]) => log)
}

// Severity order, most to least: the one reported when a Field has more than one unanswered change from the same document.
const CHANGE_ORDER = ['removed', 'replaced', 're-extracted']

/** The changes a Source document has had, `[{ change, since, replacedBy? }]`, where `since` is the ISO time it happened. */
export function sourceChanges(entry, replacedByEntry) {
  const changes = []
  if (isRemovedSource(entry)) changes.push({ change: 'removed', since: entry.removedAt })
  if (replacedByEntry) changes.push({ change: 'replaced', since: replacedByEntry.uploadedAt, replacedBy: { id: replacedByEntry.id, title: replacedByEntry.title || replacedByEntry.filename || replacedByEntry.id } })
  if (!isRemovedSource(entry) && entry.textChangedAt) changes.push({ change: 're-extracted', since: entry.textChangedAt })
  return changes
}

// #319: for every Field, the files of each code repository it drew on and the commits it accepted them at: read when it was drafted, named
// by a citation in its content, or answered for on a Bring up to date card. `{ field -> { source -> { path -> { commits, via, stages } } } }`.
function repositoryDraws({ sources, pairs, content }) {
  const repositories = new Set(sources.filter((s) => isRepositorySource(s) && !isRemovedSource(s)).map((s) => s.id))
  const draws = new Map()
  const note = (key, source, path, commit, via, stage) => {
    if (!repositories.has(source) || typeof path !== 'string' || !path || typeof commit !== 'string' || !commit) return
    const bySource = draws.get(key) ?? new Map()
    const byPath = bySource.get(source) ?? new Map()
    const at = byPath.get(path) ?? { commits: new Set(), via: new Set(), stages: new Set() }
    at.commits.add(commit)
    if (via) at.via.add(via)
    if (stage) at.stages.add(stage)
    byPath.set(path, at)
    bySource.set(source, byPath)
    draws.set(key, bySource)
  }
  for (const [stageId, log] of pairs) {
    for (const [key, record] of Object.entries(log.fields ?? {})) {
      for (const input of asList(record?.inputs)) note(key, input?.source, input?.path, input?.commit, 'drafted', stageId)
    }
    for (const entry of asList(log.entries)) {
      if (entry?.kind !== SOURCE_UPDATE_KIND || !entry.commit) continue
      for (const key of asList(entry.fields)) for (const path of asList(entry.paths)) note(key, entry.source, path, entry.commit, null, null)
    }
  }
  for (const [moduleId, record] of Object.entries(content)) {
    for (const [fieldId, value] of Object.entries(record.fields)) {
      for (const c of findSourceCitations(asText(value))) note(`${moduleId}.${fieldId}`, c.id, c.path, c.commit, 'cited', null)
    }
  }
  return draws
}

/**
 * #319: the files of each code repository that the Fields drew on, at the commits to compare with the branch head: `{ [sourceId]: [{ path, commit }] }`.
 * Takes what `findOutOfDateFields` takes. A repository nothing drew on a file of is not listed, so nothing is asked of it.
 */
export function repositoryReadsOf({ sources = [], logs = {}, modules = {} } = {}) {
  const out = {}
  for (const bySource of repositoryDraws({ sources, pairs: logPairs(logs), content: normalizeSavedContent(modules) }).values()) {
    for (const [source, byPath] of bySource) {
      const list = out[source] ?? []
      for (const [path, at] of byPath) for (const commit of at.commits) if (!list.some((r) => r.path === path && r.commit === commit)) list.push({ path, commit })
      out[source] = list
    }
  }
  return out
}

/**
 * Every Field that is Out of date.
 *
 * @param {object} input
 * @param {object[]} input.sources    the manifest's entries (removed ones included)
 * @param {object|object[]} input.logs  each Stage's decisions log, `{ stageId: log }` or a list of logs
 * @param {object|object[]} input.modules  the saved content of every Module known, as `normalizeSavedContent` takes it
 * @param {object} [input.stageModules]  `{ stageId: [moduleId] }`, to say which Stages a flagged Field belongs to
 * @param {object} [input.repositoryChanges]  #319: `{ [sourceId]: { head, results: [{ path, commit, changed, deleted }] } }`, the Gantry server's comparison of the files `repositoryReadsOf` named with each branch head; a repository missing here is not checked
 * @returns {{ field: string, cause: 'source'|'field', source?: string, sourceTitle?: string, inputField?: string, change: string, since?: string, replacedBy?: {id: string, title: string}, paths?: string[], head?: string, via: string[], stages: string[] }[]}
 */
export function findOutOfDateFields({ sources = [], logs = {}, modules = {}, stageModules = {}, repositoryChanges = {} } = {}) {
  const content = normalizeSavedContent(modules)
  const valueOf = (key) => {
    const [moduleId, ...rest] = String(key).split('.')
    return content[moduleId]?.fields?.[rest.join('.')]
  }
  const hasValue = (key) => valueOf(key) !== undefined
  const pairs = logPairs(logs)
  const byId = new Map(sources.map((s) => [s.id, s]))
  const replaced = replacedByMap(sources)

  // Which Fields each log drafted, when, from what; and the architect's answers.
  const records = new Map() // field key -> [{ stage, drafted, inputs }]
  const updates = [] // { source, fields, at, inputField, inputFingerprint }
  for (const [stageId, log] of pairs) {
    for (const [key, record] of Object.entries(log.fields ?? {})) {
      const list = records.get(key) ?? []
      list.push({ stage: stageId, drafted: time(record?.drafted), inputs: asList(record?.inputs) })
      records.set(key, list)
    }
    for (const entry of asList(log.entries)) {
      if (entry?.kind === SOURCE_UPDATE_KIND) {
        updates.push({ source: entry.source, fields: asList(entry.fields), at: time(entry.at), inputField: entry.inputField, inputFingerprint: entry.inputFingerprint })
      }
    }
  }

  const stagesMounting = (key) => {
    const moduleId = String(key).split('.')[0]
    return Object.entries(stageModules).filter(([, ids]) => asList(ids).includes(moduleId)).map(([stageId]) => stageId)
  }
  const unique = (list) => [...new Set(list.filter(Boolean))]

  // Is a change at `since` already answered for this Field: redrafted since, or the architect said keep / re-cite / redraft.
  const answered = (key, sourceId, since) => {
    const t = time(since)
    if (t === null) return false
    if ((records.get(key) ?? []).some((r) => r.drafted !== null && r.drafted >= t)) return true
    return updates.some((u) => u.source === sourceId && u.fields.includes(key) && u.at !== null && u.at >= t)
  }

  // field key -> source id -> { via: Set }
  const touching = new Map()
  const touch = (key, sourceId, via) => {
    const bySource = touching.get(key) ?? new Map()
    const vias = bySource.get(sourceId) ?? new Set()
    vias.add(via)
    bySource.set(sourceId, vias)
    touching.set(key, bySource)
  }
  for (const [key, list] of records) {
    for (const record of list) for (const input of record.inputs) if (typeof input?.source === 'string') touch(key, input.source, 'drafted')
  }
  for (const [moduleId, record] of Object.entries(content)) {
    for (const [fieldId, value] of Object.entries(record.fields)) {
      for (const id of citedSourceIds(asText(value))) touch(`${moduleId}.${fieldId}`, id, 'cited')
    }
  }

  const found = []
  for (const [key, bySource] of touching) {
    for (const [sourceId, vias] of bySource) {
      const entry = byId.get(sourceId)
      if (!entry) continue
      const open = sourceChanges(entry, replaced.get(sourceId)).filter((c) => !answered(key, sourceId, c.since))
      const worst = CHANGE_ORDER.map((name) => open.find((c) => c.change === name)).find(Boolean)
      if (!worst) continue
      const draftedStages = (records.get(key) ?? []).filter((r) => r.inputs.some((i) => i?.source === sourceId)).map((r) => r.stage)
      found.push({
        field: key,
        cause: 'source',
        source: sourceId,
        sourceTitle: entry.title || entry.filename || sourceId,
        change: worst.change,
        since: worst.since,
        ...(worst.replacedBy ? { replacedBy: worst.replacedBy } : {}),
        via: [...vias].sort(),
        stages: unique([...draftedStages, ...(vias.has('cited') ? stagesMounting(key) : [])]),
      })
    }
  }

  // #319: a Field that drew on files of a code repository, at least one of which has really changed since every commit it accepted it at.
  for (const [key, bySource] of repositoryDraws({ sources, pairs, content })) {
    for (const [sourceId, byPath] of bySource) {
      const compared = repositoryChanges?.[sourceId]
      const entry = byId.get(sourceId)
      if (!compared || !entry) continue
      const resultOf = (path, commit) => asList(compared.results).find((r) => r.path === path && r.commit === commit)
      const changedPaths = []
      const vias = new Set()
      const stages = new Set()
      for (const [path, at] of byPath) {
        const results = [...at.commits].map((commit) => resultOf(path, commit))
        // Unchanged since any commit the Field accepted it at, or not compared: nothing to say.
        if (results.some((r) => !r || r.changed === false)) continue
        changedPaths.push(path)
        for (const v of at.via) vias.add(v)
        for (const s of at.stages) stages.add(s)
      }
      if (changedPaths.length === 0) continue
      found.push({
        field: key,
        cause: 'source',
        source: sourceId,
        sourceTitle: entry.title || sourceId,
        change: 'code-changed',
        paths: changedPaths.sort(),
        head: compared.head,
        via: [...vias].sort(),
        stages: unique([...stages, ...(vias.has('cited') ? stagesMounting(key) : [])]),
      })
    }
  }

  // A draft that drew on another Field that is no longer what it saw.
  for (const [key, list] of records) {
    for (const record of list) {
      for (const input of record.inputs) {
        if (typeof input?.field !== 'string' || !hasValue(input.field) || input.fingerprint === null || input.fingerprint === undefined) continue
        const now = fingerprintText(asText(valueOf(input.field)))
        if (now === input.fingerprint) continue
        // The architect said keep / redraft for this Field while that earlier Field read as it does now (#298).
        if (updates.some((u) => u.inputField === input.field && u.fields.includes(key) && u.inputFingerprint === now)) continue
        if (found.some((f) => f.field === key && f.cause === 'field' && f.inputField === input.field)) continue
        found.push({ field: key, cause: 'field', inputField: input.field, change: 'changed', via: ['drafted'], stages: [record.stage].filter(Boolean) })
      }
    }
  }
  return found
}

/** Every flagged Field's key, once. */
export const outOfDateKeys = (flags) => [...new Set(asList(flags).map((f) => f.field))]

/** The flags of one Field, from the list `findOutOfDateFields` returns. */
export const flagsForField = (flags, key) => asList(flags).filter((f) => f.field === key)

/** The number of flagged Fields on a Stage (the run plan's mark). */
export function outOfDateCountByStage(flags) {
  const seen = new Map()
  for (const flag of asList(flags)) {
    for (const stage of flag.stages) {
      const keys = seen.get(stage) ?? new Set()
      keys.add(flag.field)
      seen.set(stage, keys)
    }
  }
  return Object.fromEntries([...seen].map(([stage, keys]) => [stage, keys.size]))
}

const fieldsLabel = (n) => (n === 1 ? '1 Field' : `${n} Fields`)

const CHANGE_WORDS = {
  removed: 'now removed',
  replaced: 'now replaced',
  're-extracted': 'now read again with different text',
  'code-changed': 'whose files have since changed',
}

/**
 * The editor banner's lines: one per document change (and one for Fields whose input Fields have changed), such as
 * `4 Fields drew on Client brief, now replaced`. `{ text, count, source?, change, fields }[]`.
 */
export function outOfDateBannerLines(flags) {
  const groups = new Map()
  for (const flag of asList(flags)) {
    const id = flag.cause === 'source' ? `${flag.source}|${flag.change}|${flag.replacedBy?.id ?? ''}` : 'field'
    const group = groups.get(id) ?? { flag, fields: new Set() }
    group.fields.add(flag.field)
    groups.set(id, group)
  }
  return [...groups.values()].map(({ flag, fields }) => {
    const count = fields.size
    if (flag.cause !== 'source') return { text: `${fieldsLabel(count)} drew on a Field that has since changed`, count, change: flag.change, fields: [...fields] }
    const replacedNote = flag.change === 'replaced' && flag.replacedBy ? ` by ${flag.replacedBy.title}` : ''
    return {
      text: `${fieldsLabel(count)} drew on ${flag.sourceTitle}, ${CHANGE_WORDS[flag.change]}${flag.change === 'replaced' ? replacedNote : ''}`,
      count,
      source: flag.source,
      change: flag.change,
      fields: [...fields],
    }
  })
}

/** #319: why a Field that drew on a code repository is flagged: `orders/service.ts in Billing API changed (now at 3f2a9c1)`. */
export function codeChangeReason(flag) {
  const paths = asList(flag.paths)
  const files = paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`
  return `${files} in ${flag.sourceTitle} changed${flag.head ? ` (now at ${shortCommit(flag.head)})` : ''}`
}

/** The mark a single Field shows, e.g. `Out of date: Client brief was replaced by Client brief v3`. */
export function outOfDateFieldNote(flags) {
  const reasons = asList(flags).map((flag) => {
    if (flag.cause !== 'source') return 'a Field it drew on has changed'
    if (flag.change === 'removed') return `${flag.sourceTitle} was removed`
    if (flag.change === 'replaced') return `${flag.sourceTitle} was replaced${flag.replacedBy ? ` by ${flag.replacedBy.title}` : ''}`
    if (flag.change === 'code-changed') return codeChangeReason(flag)
    return `${flag.sourceTitle} was read again with different text`
  })
  return `Out of date: ${[...new Set(reasons)].join('; ')}`
}

// ---------- New since last interview ----------

/** When the last interview saved anything: the latest `lastAiSave` of any session, or a Field's draft time, across the Stages' logs; null when no interview has run. */
export function lastInterviewAt(logs) {
  let latest = null
  const note = (iso) => {
    const t = time(iso)
    if (t !== null && (latest === null || t > latest)) latest = t
  }
  for (const [, log] of logPairs(logs)) {
    for (const status of asList(log.status)) note(status?.lastAiSave)
    for (const record of Object.values(log.fields ?? {})) note(record?.drafted)
  }
  return latest === null ? null : new Date(latest).toISOString()
}

/**
 * The live Source documents added since the last interview that replace nothing: they change no Field, they are only marked "New since last interview" so the next interview reads them against what is saved. Nothing is "new" until an interview has run at all.
 */
export function newSinceLastInterview(sources, logs) {
  const last = time(lastInterviewAt(logs))
  if (last === null) return []
  return asList(sources).filter((s) => !isRemovedSource(s) && !s.replaces && (time(s.uploadedAt) ?? 0) > last)
}
