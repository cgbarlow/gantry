// #288 (parent #238, docs/adr/0064 as amended by 0068 and #255): the **decisions log**, `interview/<stageId>.yaml`, kept next to a
// Stage's `modules/`, `sources/` and `assets/` in every workspace kind and committed in the same Save as the Stage's content.
//
// Three parts:
//   * `status`   one entry per session: who, the run's target Stage, this Stage's state (and, in a run, each Stage's state), the Artefact aimed for, the last AI save,
//                each AI Provider type and model used (with its tokens), the Interview instructions version, the skill versions.
//                Never a key, an address or a custom name: `sessionStatus` builds an entry from a short list of known keys only.
//   * `fields`   one record per drafted Field: what it was drafted from (Source documents and pages, earlier-Stage Fields), each
//                with a fingerprint, and the ids of the entries that fed it. Overwritten when the Field is redrafted.
//   * `entries`  APPEND-ONLY. Nothing here edits or deletes one: a changed answer is a new entry with `replaces`, an open question
//                is closed by an entry with `resolves`. `appendEntries` and `assertAppendOnly` are the only way entries change.
//
// The file is shared by the browser (a Local workspace reads and writes it through its folder handle) and the server, so this has
// no DOM, no network and no `node:` import. tests/decisionsLog.test.js drives all of it.
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'

export const DECISIONS_LOG_VERSION = 1

/** The entry kinds built by #288. The log adds more by their own tickets, and shows any kind it does not know as it is. */
export const ENTRY_KINDS = Object.freeze(['answer', 'fact', 'saved-content', 'open-question', 'artefact', 'restart', 'model-change'])

/** Where a Stage's log lives, relative to the Instance's folder. */
export const decisionsLogPath = (stageId) => `interview/${stageId}.yaml`

export class DecisionsLogError extends Error {
  constructor(message, { code = 'bad-log', status = 400 } = {}) {
    super(message)
    this.name = 'DecisionsLogError'
    this.code = code
    this.status = status
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

/** A log with nothing in it. */
export const emptyDecisionsLog = (stageId = '') => ({ version: DECISIONS_LOG_VERSION, stage: stageId, status: [], fields: {}, entries: [] })

// ---------- the status block ----------

// A value that could be a key or an address is never written, whatever field it arrived in.
const KEY_LIKE = /(\bsk-[\w-]{8,}|\bBearer\s|\bapi[_-]?key\b|\bAKIA[0-9A-Z]{12,}|\bghp_[\w]{10,}|:\/\/|@[\w.-]+\.[a-z]{2,})/i

/** A short plain word-ish value (a type, a model id, a name): '' if it could be a key, an address or free prose. */
export function safeToken(value, max = 120) {
  const text = String(value ?? '').trim()
  if (!text || text.length > max || /\s/.test(text) || KEY_LIKE.test(text)) return ''
  return text
}

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0)

/** One model's line in a status entry. `tokens` is null for an outside agent, whose tokens are "not reported". */
export function modelUsage({ type, model, inputTokens, cachedTokens, outputTokens, reported = true } = {}) {
  const line = { type: safeToken(type, 40), model: safeToken(model) }
  if (reported === false) return { ...line, tokens: 'not reported' }
  return { ...line, inputTokens: count(inputTokens), cachedTokens: count(cachedTokens), outputTokens: count(outputTokens) }
}

/**
 * A status entry built from known keys only, so a key, an address or a custom name handed in by mistake cannot reach the file.
 * `session` and `who` are required in practice; everything else may be absent.
 */
export function sessionStatus(input = {}) {
  const status = { session: safeToken(input.session, 60), who: String(input.who ?? '').trim().slice(0, 120) }
  if (KEY_LIKE.test(status.who)) status.who = ''
  status.target = safeToken(input.target, 80) || null
  status.state = safeToken(input.state, 40) || null
  // #293: each Stage of a run and its state, so a paused run knows where it stands. Stage ids and state words only.
  const stages = isObject(input.stages) ? input.stages : {}
  const runStages = Object.fromEntries(Object.entries(stages).map(([id, state]) => [safeToken(id, 80), safeToken(state, 40)]).filter(([id, state]) => id && state))
  if (Object.keys(runStages).length) status.stages = runStages
  status.artefact = safeToken(input.artefact, 80) || null
  status.lastAiSave = typeof input.lastAiSave === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.lastAiSave) ? input.lastAiSave : null
  status.models = asArray(input.models).map(modelUsage).filter((m) => m.type && m.model)
  status.instructions = safeToken(input.instructions, 80) || null
  const skills = isObject(input.skills) ? input.skills : {}
  status.skills = Object.fromEntries(Object.entries(skills).map(([id, version]) => [safeToken(id, 60), safeToken(version, 60)]).filter(([id, version]) => id && version))
  return status
}

// ---------- entries ----------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function cleanEntry(entry) {
  if (!isObject(entry)) throw new DecisionsLogError('A decisions log entry must be an object.')
  if (typeof entry.id !== 'string' || entry.id.trim() === '') throw new DecisionsLogError('Every decisions log entry needs an id.')
  if (typeof entry.kind !== 'string' || entry.kind.trim() === '') throw new DecisionsLogError(`Entry ${entry.id} needs a kind.`)
  return entry
}

/**
 * Throws if `after` is not `before` with entries added at the end: every entry already there must still be there, in the same place,
 * with the same content. This is the append-only rule (ADR-0064) as a check anything that writes a log can run on its result.
 */
export function assertAppendOnly(before, after) {
  const was = before?.entries ?? []
  const now = after?.entries ?? []
  if (now.length < was.length) throw new DecisionsLogError('A decisions log entry cannot be removed.', { code: 'append-only', status: 409 })
  for (let i = 0; i < was.length; i++) {
    if (!sameJson(was[i], now[i])) throw new DecisionsLogError(`Decisions log entry ${was[i]?.id ?? i + 1} cannot be changed. Add an entry that replaces it.`, { code: 'append-only', status: 409 })
  }
}

/**
 * The log with `entries` added to the end, oldest first (by `at`). An entry whose id is already in the log and is identical is
 * skipped (a Save sent twice adds nothing); one whose id is there with different content is refused, because that would change
 * an entry. Returns `{ log, added }`; `log` is a new object and the one passed in is not touched.
 */
export function appendEntries(log, entries) {
  const base = log ?? emptyDecisionsLog()
  const existing = new Map(base.entries.map((e) => [e.id, e]))
  const fresh = []
  for (const raw of asArray(entries)) {
    const entry = cleanEntry(raw)
    const there = existing.get(entry.id)
    if (there) {
      if (!sameJson(there, entry)) throw new DecisionsLogError(`Decisions log entry ${entry.id} already exists with different content. Entries are append-only: add an entry that replaces it.`, { code: 'append-only', status: 409 })
      continue
    }
    if (fresh.some((e) => e.id === entry.id)) continue
    fresh.push(entry)
  }
  fresh.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  const next = { ...base, entries: [...base.entries, ...fresh] }
  assertAppendOnly(base, next)
  return { log: next, added: fresh }
}

/**
 * What a Save sends for the log (`delta`): `{ status?, fields?, entries? }`. Applies it to `log`: the session's status entry is
 * replaced in place, each Field's record is overwritten, and the entries are appended. Returns the new log.
 */
export function applyDecisionsDelta(log, delta, stageId = '') {
  const base = log ?? emptyDecisionsLog(stageId)
  let next = { ...base, version: DECISIONS_LOG_VERSION, stage: base.stage || stageId }
  if (isObject(delta?.status)) {
    const status = sessionStatus(delta.status)
    if (status.session) {
      const at = next.status.findIndex((s) => s.session === status.session)
      next = { ...next, status: at === -1 ? [...next.status, status] : next.status.map((s, i) => (i === at ? status : s)) }
    }
  }
  if (isObject(delta?.fields)) {
    const fields = { ...next.fields }
    for (const [key, record] of Object.entries(delta.fields)) {
      if (!isObject(record) || !/^[\w-]+\.[\w.-]+$/.test(key)) continue
      fields[key] = {
        drafted: typeof record.drafted === 'string' ? record.drafted : null,
        inputs: asArray(record.inputs).filter(isObject).map(cleanInput),
        entries: asArray(record.entries).map(String),
      }
    }
    next = { ...next, fields }
  }
  if (delta?.entries !== undefined) next = appendEntries(next, delta.entries).log
  assertAppendOnly(base, next)
  return next
}

function cleanInput(input) {
  const out = {}
  if (input.source !== undefined) out.source = String(input.source)
  if (input.field !== undefined) out.field = String(input.field)
  if (input.title !== undefined) out.title = String(input.title)
  if (input.range !== undefined) out.range = input.range === null ? null : String(input.range)
  out.fingerprint = input.fingerprint === undefined || input.fingerprint === null ? null : String(input.fingerprint)
  return out
}

// ---------- the file ----------

/** The log as the file holds it: YAML, keys in a fixed order so two writers produce the same bytes. */
export function serializeDecisionsLog(log) {
  const value = log ?? emptyDecisionsLog()
  return stringifyYAML(
    {
      version: DECISIONS_LOG_VERSION,
      stage: value.stage ?? '',
      status: (value.status ?? []).map((s) => sessionStatus(s)),
      fields: value.fields ?? {},
      entries: value.entries ?? [],
    },
    { lineWidth: 0 }
  )
}

/** A log from its file. A missing or blank file is an empty log; one that does not parse is an error, never silently emptied. */
export function parseDecisionsLog(text, stageId = '') {
  if (text === null || text === undefined || String(text).trim() === '') return emptyDecisionsLog(stageId)
  let parsed
  try {
    parsed = parseYAML(String(text))
  } catch (err) {
    throw new DecisionsLogError(`The decisions log for ${stageId || 'this Stage'} could not be read: ${err.message}`, { code: 'unreadable-log', status: 422 })
  }
  if (parsed === null || parsed === undefined) return emptyDecisionsLog(stageId)
  if (!isObject(parsed)) throw new DecisionsLogError(`The decisions log for ${stageId || 'this Stage'} is not a log file.`, { code: 'unreadable-log', status: 422 })
  return {
    version: DECISIONS_LOG_VERSION,
    stage: typeof parsed.stage === 'string' ? parsed.stage : stageId,
    status: asArray(parsed.status).filter(isObject),
    fields: isObject(parsed.fields) ? parsed.fields : {},
    entries: asArray(parsed.entries).filter((e) => isObject(e) && typeof e.id === 'string'),
  }
}

// ---------- reading it ----------

/**
 * The entries that currently hold: everything after the last restart marker, without an entry a later one `replaces`, and with
 * an open question dropped once a later entry `resolves` it. `decisions` is `{ entries }` or the entries themselves.
 */
export function currentLogEntries(decisions) {
  const all = (Array.isArray(decisions) ? decisions : decisions?.entries ?? []).filter((e) => e && typeof e === 'object')
  const lastRestart = all.map((e) => e.kind).lastIndexOf('restart')
  const entries = lastRestart === -1 ? all : all.slice(lastRestart + 1)
  const replaced = new Set(entries.map((e) => e.replaces).filter(Boolean).flat())
  const resolved = new Set(entries.map((e) => e.resolves).filter(Boolean).flat())
  return entries.filter((e) => e.kind !== 'restart' && !replaced.has(e.id) && !(e.kind === 'open-question' && resolved.has(e.id)))
}

/** The open questions that are still open. */
export const openQuestions = (decisions) => currentLogEntries(decisions).filter((e) => e.kind === 'open-question')

/**
 * What the Decisions log panel and the Interview rail show: the latest answers (the entries that hold, answers and facts and
 * saved-content choices), the open questions, and every entry in order for "history". `count` is what the rail shows.
 */
export function logSummary(decisions) {
  const all = (Array.isArray(decisions) ? decisions : decisions?.entries ?? []).filter((e) => e && typeof e === 'object')
  const current = currentLogEntries(all)
  const open = current.filter((e) => e.kind === 'open-question')
  const latest = current.filter((e) => e.kind !== 'open-question' && e.kind !== 'model-change' && e.kind !== 'artefact')
  return { latest, open, history: all, count: latest.length + open.length, total: all.length }
}

// ---------- chat that feeds nothing ----------

const FILLER = new Set(
  ('thanks thank you ok okay yes yep yeah yup sure great cool fine good sounds go on carry continue proceed next please got it perfect nice right no nope ' +
    'that s works looks lovely awesome ta cheers alright then and the a all well done brilliant excellent agreed noted understood makes sense lets let keep going ahead ' +
    'happy with this me now do so very much appreciate fab super lot many').split(' ')
)

/** "Thanks", "go on", "ok sounds good": chat that tells the AI nothing, which the log never keeps. */
export function isAcknowledgement(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  return words.length <= 10 && words.every((w) => FILLER.has(w))
}

const squash = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Finds the architect's own message that holds `quote`. `messages` are the architect's free-chat messages as they typed them.
 * Returns the whole message (word for word), or null when no message holds the quote, or the message is only an
 * acknowledgement. The AI's wording is never what is kept: only text the architect typed can be found here.
 */
export function findArchitectMessage(messages, quote) {
  const wanted = squash(quote)
  if (wanted.length < 3) return null
  for (const message of messages) {
    if (squash(message).includes(wanted) && !isAcknowledgement(message)) return String(message).trim()
  }
  return null
}
