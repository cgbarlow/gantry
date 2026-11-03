import {
  DecisionsLogError,
  ENTRY_KINDS,
  OUTSIDE_AGENT,
  OUTSIDE_AGENT_TYPE,
  TOKENS_NOT_REPORTED,
  appendEntries,
  currentLogEntries,
  safeToken,
} from '../web/lib/decisionsLog.js'
import { inputsForDraft } from '../web/lib/interviewSources.js'
import { interviewSkillVersions } from '../web/lib/interviewSkills.js'
import { citedSourceIds } from '../web/lib/sourceCitations.js'

// #307 (map #238, docs/adr/0067 with 0064, 0063 and 0068): an **outside agent** (Claude Code, say) running an AI interview session over
// the Gantry MCP server. It has the in-app AI's role, so Gantry holds it to the in-app AI's rules; it asks its questions in its own chat,
// so question cards play no part. This file is everything the server needs of a session that is not already shared with the browser:
//
//   * `parseSession`        the session the agent says it is in (id, "run until" Stage, state, the model it reports);
//   * `planSessionDecisions` what a Save or Pause writes to the Stage's decisions log: the agent's entries stamped **recorded by an outside
//                           agent**, the session's status line (tokens "not reported"), and the `fields` section rebuilt from the content's
//                           citations and the entries that name each Field, so Out of date detection (web/lib/outOfDate.js) works;
//   * `advanceRefusal`, `approvalRefusal`  the guard rails Gantry itself enforces for an agent in a session, with the in-app AI's reasons.
//
// The shared-module rule (lib/draftAheadGuard.js) and approvals in Stage order (lib/stageOrder.js) are enforced on every Module write and every
// Request approval, in a session or not, so an agent in a session meets exactly the refusals the in-app AI does, with the same words.
// "In a session" is the agent saying so: a write that carries a session is held to what follows; one that carries none is a person in the web UI.
//
// Pure apart from the two readers `planSessionDecisions` is handed: nothing here touches a store or the network.

/** The states a session's Stage can be in (web/lib/interviewRun.js writes the same words). */
export const SESSION_STATES = Object.freeze(['in-progress', 'paused', 'saved', 'done', 'awaiting-approval', 'approval-queued', 'head-start'])

/** Entry kinds an agent may add: every kind but `model-change` (the status line names the model). */
export const AGENT_ENTRY_KINDS = Object.freeze(ENTRY_KINDS.filter((kind) => kind !== 'model-change'))

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const text = (v) => (typeof v === 'string' ? v.trim() : '')
const FIELD_KEY = /^[\w-]+\.[\w.-]+$/

const refuse = (message, code = 'bad-session', status = 400) => new DecisionsLogError(message, { code, status })

/**
 * The session an agent says it is in: `{ id, runUntil, state, model, who, artefact, stages, instructions }`. Throws `DecisionsLogError` (400)
 * when there is no usable id or the state is not one Gantry knows. The model is whatever the agent reports (never checked, and never a key:
 * anything that could be an address or a key reads as "unknown").
 */
export function parseSession(input) {
  if (!isObject(input)) throw refuse('A session needs { id, runUntil, state, model }. Start one with start_interview_session.', 'session-required')
  const id = safeToken(input.id, 60)
  if (!id) throw refuse('The session needs an "id": use the one start_interview_session gave you.', 'session-required')
  const state = input.state === undefined || input.state === null || input.state === '' ? 'in-progress' : String(input.state)
  if (!SESSION_STATES.includes(state)) throw refuse(`The session state "${state}" is not one Gantry knows. Use one of: ${SESSION_STATES.join(', ')}.`, 'bad-session-state')
  return {
    id,
    runUntil: safeToken(input.runUntil, 80) || null,
    state,
    model: safeToken(input.model) || 'unknown',
    who: text(input.who).slice(0, 120),
    artefact: safeToken(input.artefact, 80) || null,
    stages: isObject(input.stages) ? input.stages : undefined,
    instructions: safeToken(input.instructions, 80) || null,
  }
}

// ---------- entries ----------

// What each kind has to carry for a reader (and the AI on resume) to make sense of it. Light on purpose: the log takes any kind as it is.
function entryProblem(entry, index) {
  const at = `Entry ${index + 1} (${entry.kind})`
  const fields = asList(entry.fields)
  if (fields.some((f) => typeof f !== 'string' || !FIELD_KEY.test(f))) return `${at}: "fields" must be Fields written as module.field.`
  switch (entry.kind) {
    case 'answer':
      return text(entry.question) && (entry.answer !== undefined && entry.answer !== null && entry.answer !== '') ? null : `${at} needs the "question" asked and the architect's "answer".`
    case 'fact':
      return text(entry.words) ? null : `${at} needs "words", the architect's own message copied exactly as they typed it, and the "fields" it feeds.`
    case 'open-question':
      return text(entry.question) ? null : `${at} needs the "question" that stays open.`
    case 'term':
      return text(entry.preferred) ? null : `${at} needs the "preferred" term (and the names to "avoid").`
    case 'saved-content':
      return fields.length === 1 && ['keep', 'replace', 'merge'].includes(entry.choice) ? null : `${at} needs one Field in "fields" and a "choice" of keep, replace or merge.`
    case 'source-update':
      return fields.length && text(entry.outcome) ? null : `${at} needs the "fields" it is about and the "outcome" (keep, redraft, redraft-without, re-cite or open-question).`
    case 'review-answered':
      return text(entry.outcome) ? null : `${at} needs the thread's "outcome" (accept, revise, keep, cant-settle, note, assign or reopen).`
    default:
      return null
  }
}

/**
 * The agent's entries, each given what Gantry owns: an `id` (`<session>-<n>`, continuing after the session's highest number in `log`, unless
 * the agent gave one), the `session`, `who`, an `at` time, and the **recorded by an outside agent** label with the model the agent reports.
 * Anything the agent put in those places is overwritten, so the label cannot be left off or changed. Throws `DecisionsLogError` for an entry
 * that is not an object, has an unknown kind or lacks what its kind needs, or that `replaces` / `resolves` an entry that is not in the log.
 */
export function labelEntries(entries, { session, log, now }) {
  const list = asList(entries)
  const known = new Set((log?.entries ?? []).map((e) => e.id))
  let counter = 0
  for (const entry of log?.entries ?? []) {
    const match = String(entry.id).match(/-(\d+)$/)
    if (entry.session === session.id && match) counter = Math.max(counter, Number(match[1]))
  }
  const labelled = []
  list.forEach((raw, index) => {
    if (!isObject(raw)) throw refuse(`Entry ${index + 1} must be an object.`, 'bad-entry')
    const kind = typeof raw.kind === 'string' ? raw.kind : ''
    if (kind === 'model-change') throw refuse('Entry kind "model-change" is Gantry\'s own: the session status already names your model.', 'bad-entry')
    if (!AGENT_ENTRY_KINDS.includes(kind)) throw refuse(`Entry ${index + 1} has kind "${kind}", which Gantry does not know. Use one of: ${AGENT_ENTRY_KINDS.join(', ')}.`, 'bad-entry')
    const problem = entryProblem(raw, index)
    if (problem) throw refuse(problem, 'bad-entry')
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${session.id}-${++counter}`
    const at = typeof raw.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.at) ? raw.at : now
    const { recordedBy: _by, agentModel: _model, ...rest } = raw
    labelled.push({ ...rest, id, at, session: session.id, ...(session.who ? { who: session.who } : {}), recordedBy: OUTSIDE_AGENT, agentModel: session.model })
  })
  const batchIds = new Set(labelled.map((e) => e.id))
  for (const entry of labelled) {
    for (const link of [...asList(entry.replaces), ...asList(entry.resolves)]) {
      if (!known.has(link) && !batchIds.has(link)) throw refuse(`Entry ${entry.id} replaces or resolves "${link}", which is not in this Stage's decisions log. Read it with read_decisions_log and use an id from there.`, 'bad-entry')
    }
  }
  return labelled
}

// ---------- the log's three parts ----------

// The inputs of a Field drafted by an agent are the Source documents its text cites (fingerprinted by their extracted text), the same inputs
// the browser records for a draft that cites them: a citation alone is an input of the whole document.
function fieldRecords({ written, modules, sources, entries, now }) {
  const records = {}
  for (const key of written) {
    if (!FIELD_KEY.test(key)) continue
    const dot = key.indexOf('.')
    const value = modules?.[key.slice(0, dot)]?.fields?.[key.slice(dot + 1)]
    records[key] = {
      drafted: now,
      inputs: inputsForDraft({ reads: [], value, sources }),
      entries: entries.filter((entry) => asList(entry.fields).includes(key)).map((entry) => entry.id),
    }
  }
  return records
}

/** The Source document ids the written Fields cite (so the caller reads the text of just those). */
export function citedBy(written, modules) {
  const ids = new Set()
  for (const key of written) {
    const dot = key.indexOf('.')
    const value = modules?.[key.slice(0, dot)]?.fields?.[key.slice(dot + 1)]
    for (const id of citedSourceIds(Array.isArray(value) ? value.join('\n') : String(value ?? ''))) ids.add(id)
  }
  return [...ids]
}

/** The newest status line of `sessionId` in a log, or null. */
export const sessionStatusOf = (log, sessionId) => (log?.status ?? []).filter((s) => s.session === sessionId).at(-1) ?? null

function statusInput(session, { previous, saved, now }) {
  const earlier = asList(previous?.saves).length ? asList(previous.saves) : previous?.lastAiSave ? [previous.lastAiSave] : []
  const saves = saved ? [...earlier.filter((t) => t !== now), now] : earlier
  const skills = interviewSkillVersions()
  return {
    session: session.id,
    who: session.who || previous?.who || '',
    target: session.runUntil ?? previous?.target,
    state: session.state,
    stages: session.stages ?? previous?.stages,
    artefact: session.artefact ?? previous?.artefact,
    lastAiSave: saved ? now : previous?.lastAiSave ?? null,
    saves,
    // The agent reports its model; it reports no tokens, and Gantry does not count them (ADR-0067).
    models: [{ type: OUTSIDE_AGENT_TYPE, model: session.model, tokens: TOKENS_NOT_REPORTED }],
    instructions: session.instructions ?? previous?.instructions,
    skills: Object.fromEntries(skills.skills.map((s) => [s.id, s.version])),
    recordedBy: OUTSIDE_AGENT,
  }
}

/**
 * What a Save (or a Pause) by an agent in a session writes to the Stage's decisions log, as the `decisions` delta the log's writer takes
 * (`{ status, fields, entries }`).
 *
 * @param {object} input
 * @param {object} input.session   from `parseSession`
 * @param {object[]} [input.entries] the agent's entries (see `labelEntries`)
 * @param {object} input.log       the Stage's committed log (an empty one when there is none)
 * @param {string[]} [input.written] the Fields (`module.field`) this Save puts content in that the stage did not hold (`writtenFields`)
 * @param {object} [input.modules]   the Save's modules, `{ [moduleId]: { fields } }`
 * @param {object[]} [input.sources] the Source documents the written Fields cite, `{ id, title, filename, text }` (the text fingerprints them)
 * @param {boolean} input.saved    whether the call saves content (a Pause with nothing to save does not move the last save)
 * @param {string} input.now       an ISO time
 */
export function planSessionDecisions({ session, entries, log, written = [], modules = {}, sources = [], saved, now }) {
  const labelled = labelEntries(entries, { session, log, now })
  // The entries as they will stand: a Field's record lists the entries that currently feed it, this call's included.
  const after = appendEntries(log, labelled).log
  const standing = currentLogEntries(after)
  const previous = sessionStatusOf(log, session.id)
  return {
    entryCount: labelled.length,
    decisions: {
      status: statusInput(session, { previous, saved, now }),
      fields: fieldRecords({ written, modules, sources, entries: standing, now }),
      entries: labelled,
    },
  }
}

// ---------- guard rails ----------

/** The refusal an agent in a session gets for passing a Gate on a workspace whose Stages move on by Pull Request. The in-app AI is told the same (rule "stage-ready"). */
export const REMOTE_GATE_REFUSAL = (stageTitle) =>
  `An AI in an interview session never passes a Gate: a Gate that needs approval or review stops it. ${stageTitle ? `"${stageTitle}"` : 'The current Stage'} moves on only when its Pull Request is approved and merged, so request approval (request_approval), then check_status once the Owner has had time to review. Only the Owner's approval moves the Instance on.`

/** The refusal for advancing before the Stage was saved at the architect's confirm. */
export const UNSAVED_ADVANCE_REFUSAL = (stageTitle) =>
  `An AI in an interview session advances an Instance only after the architect confirmed the stage summary and chose "Save, advance, carry on". "${stageTitle}" has no save of this session with the state "saved" yet: ask the architect, then call update_instance_modules with the session state "saved", then advance_stage. A Pause or "Save and stop here" leaves the Instance on its Stage.`

/** The refusal for asking for approval of a Stage the session has not saved. */
export const UNSAVED_APPROVAL_REFUSAL = (stageTitle) =>
  `An AI in an interview session asks for approval only after the architect confirmed the stage summary and the session saved "${stageTitle}". This session has not saved it yet: ask the architect, then call update_instance_modules with the session, then request_approval.`

/**
 * `null`, or the refusal for an agent in `sessionId` calling advance_stage. A Workspace-backed Instance (Pull Request approval) is never
 * advanced by an AI; a local or server Instance only once the session saved the Stage with the state "saved" (the architect's "Save,
 * advance, carry on"). Gantry still re-checks the Gate itself, as it does for a person.
 */
export function advanceRefusal({ providerBacked, log, sessionId, stageTitle }) {
  if (providerBacked) return REMOTE_GATE_REFUSAL(stageTitle)
  return sessionStatusOf(log, sessionId)?.state === 'saved' ? null : UNSAVED_ADVANCE_REFUSAL(stageTitle)
}

/** `null`, or the refusal for an agent in `sessionId` requesting approval of a Stage whose log shows no save by that session. */
export function approvalRefusal({ log, sessionId, stageTitle }) {
  return sessionStatusOf(log, sessionId)?.lastAiSave ? null : UNSAVED_APPROVAL_REFUSAL(stageTitle)
}

/** The session id a call names (a query value or a body field), or '' when it is not in a session. */
export function sessionIdOf(value) {
  return safeToken(value, 60)
}
