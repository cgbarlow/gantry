// #290 (parent #238, docs/adr/0064 and 0068): resuming an AI interview. A session paused in one browser carries on in any other, because
// everything it needs is in the Stage's decisions log (`interview/<stageId>.yaml`) and the saved content; nothing about the old
// conversation is kept. This file works out, from the logs, whether a Stage is being resumed, what to recap, which earlier session
// of the same architect to take over, and which other sessions on the Stage are still going (the two-sessions warning).
//
// Pure: no DOM, no network, no storage. The Interview page reads the logs (web/lib/decisionsStore.js) and, on a workspace that has a
// Provider to ask, Check status once, and hands both here.
import { STARTED_OVER, currentLogEntries, logSummary, openQuestions } from './decisionsLog.js'

/** A session in these states is finished with the Stage: it saved at the end of the run, or Start this stage over ended it (#348). */
export const DONE_STATES = Object.freeze(['saved', 'done', STARTED_OVER])
/** A Stage the Provider reports in one of these states has been moved on past the interview. */
export const MOVED_ON_STAGE_STATES = Object.freeze(['approved', 'advanced', 'merged', 'complete', 'done'])

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const shorten = (text, max = 60) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * What the Provider reports overrides the file (ADR-0064). `providerStates` maps a Stage id to the state Check status found
 * (`approved`, `advanced`, …); a Stage past the interview has no session still going, whatever its status block says.
 */
export function sessionIsDone(status, stageState) {
  if (stageState && MOVED_ON_STAGE_STATES.includes(String(stageState))) return true
  return DONE_STATES.includes(String(status?.state ?? ''))
}

const savedAt = (status) => String(status?.lastAiSave ?? '')

/**
 * The session of this architect that was paused, to take over: its id, so the resumed run is that session carrying on (one
 * status line, its token totals kept) rather than a stranger. The most recent Pause wins. Null when there is none.
 */
export function adoptableSession(log, actor) {
  const paused = (log?.status ?? []).filter((s) => s.state === 'paused' && same(s.who, actor))
  paused.sort((a, b) => savedAt(b).localeCompare(savedAt(a)))
  return paused[0] ?? null
}

/** Sessions on the Stage, other than `self`, that are not Done: what the two-sessions card names. */
export function otherSessions(log, { self = '', stageState = null } = {}) {
  return (log?.status ?? [])
    .filter((s) => s.session && s.session !== self && !sessionIsDone(s, stageState))
    .map((s) => ({ session: s.session, who: s.who || '', state: s.state || 'in-progress', lastAiSave: s.lastAiSave || null }))
}

/** What the log says the AI last asked about, in a few words, or ''. */
export function lastAskedAbout(log, fieldTitle = (key) => key) {
  const entries = currentLogEntries(log).filter((e) => ['answer', 'open-question', 'fact'].includes(e.kind))
  const last = entries.at(-1)
  if (!last) return ''
  const field = Array.isArray(last.fields) ? last.fields[0] : null
  if (last.kind === 'answer') return shorten(last.header || (field ? fieldTitle(field) : last.question))
  if (last.kind === 'open-question') return shorten(last.question)
  return field ? shorten(fieldTitle(field)) : shorten(last.words)
}

/** "Resuming Shape: 14 decisions, 2 open questions, last asked about hosting". */
export function recapLine(log, { stageTitle = 'this Stage', fieldTitle } = {}) {
  const summary = logSummary(log)
  const parts = [plural(summary.latest.length, 'decision'), plural(summary.open.length, 'open question')]
  const about = lastAskedAbout(log, fieldTitle)
  if (about) parts.push(`last asked about ${about}`)
  return `Resuming ${stageTitle}: ${parts.join(', ')}`
}

/**
 * Everything the page and the session need to know about resuming `stageId`.
 *
 * @param {object} input
 * @param {Record<string, object>} input.logs         each Stage's committed log, by Stage id
 * @param {string} input.stageId
 * @param {string} [input.stageTitle]
 * @param {string} [input.actor]                      who is interviewing
 * @param {Record<string, string>} [input.providerStates]  what Check status reported, by Stage id (it overrides the file)
 * @param {Array<{id: string, title?: string}>} [input.stages]  the Definition's Stages, in order
 * @param {(key: string) => string} [input.fieldTitle]
 * @returns {{ resuming: boolean, recap: string, adopt: object|null, others: object[], earlier: object[], stageState: string|null }}
 */
export function resumeInfo({ logs = {}, stageId, stageTitle, actor = '', providerStates = {}, stages = [], fieldTitle } = {}) {
  const log = logs[stageId] ?? null
  const stageState = providerStates[stageId] ?? null
  const adopt = adoptableSession(log, actor)
  const others = otherSessions(log, { self: adopt?.session ?? '', stageState })
  const decided = currentLogEntries(log)
  const resuming = decided.length > 0 || Boolean(adopt)
  const earlier = []
  for (const stage of stages) {
    if (stage.id === stageId) break
    const other = logs[stage.id]
    if (!other) continue
    const summary = logSummary(other)
    if (summary.count === 0) continue
    earlier.push({ id: stage.id, title: stage.title ?? stage.id, decisions: summary.latest.length, open: summary.open.length, state: providerStates[stage.id] ?? null })
  }
  return { resuming, recap: resuming ? recapLine(log, { stageTitle: stageTitle ?? stageId, fieldTitle }) : '', adopt, others, earlier, stageState, open: openQuestions(log).length }
}

/**
 * The first message of a resumed run. The AI is given the log and the saved content (both are in its brief), not the old
 * conversation: it opens with the recap and then asks the next round.
 */
export function resumeOpening(info) {
  const lines = [
    'Resume the interview. You are carrying on from where it stopped, and you do not have the earlier conversation. Everything you need is in your brief: the saved content and the decisions log so far.',
    `Open with this recap, in one short line: "${info.recap}".`,
    'Then ask your next round of question cards: every question whose prerequisites are settled, starting with the open questions in the decisions log. Do not ask again anything the log or the saved content already settles, and do not start by reading the Source documents again; read one only when a question needs it.',
  ]
  if (info.earlier?.length) {
    lines.push(`Earlier Stages have decisions logs too: ${info.earlier.map((s) => `${s.title} (${plural(s.decisions, 'decision')}, ${plural(s.open, 'open question')})`).join('; ')}. Their saved content is in your brief.`)
  }
  if (info.stageState) lines.push(`Gantry's Check status reports this Stage as ${info.stageState}.`)
  return lines.join('\n')
}

/** When a session last saved, for the card that names it. */
export function describeSaved(iso, now = Date.now()) {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return 'has not saved yet'
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'saved just now'
  if (minutes < 60) return `last saved ${plural(minutes, 'minute')} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `last saved ${plural(hours, 'hour')} ago`
  return `last saved ${plural(Math.round(hours / 24), 'day')} ago`
}
