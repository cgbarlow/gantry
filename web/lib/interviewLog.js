// #288 (parent #238, docs/adr/0064): the interview session's side of the **decisions log** (web/lib/decisionsLog.js is the file).
// While a session runs, this collects what the log is to hold and hands it to the stage Save as one `delta`:
//
//   * entries  the question cards the architect answered, the facts they gave in free chat (word for word), their keep / replace /
//              merge choice on saved content, open questions, the Artefact aimed for, a restart marker and a change of model;
//   * fields   what each drafted Field was drafted from (Source documents and pages, earlier-Stage Fields, each with a fingerprint)
//              and the entries that fed it;
//   * status   this session's line: who, target Stage, state, Artefact, last AI save, each model used with its tokens, the
//              Interview instructions version and the skill versions.
//
// A hand edit of a drafted Field (#289) is kept as the text they typed. Only the architect's own words are kept. The AI's replies are never stored, and a message of thanks or "go on" feeds nothing: a
// fact is logged only when the AI quotes text the architect typed (`findArchitectMessage`), and an acknowledgement never matches.
//
// Nothing here writes a file. The entries wait as `pending` until the Save that carries them succeeds (`commit`).
import { appendEntries, currentLogEntries, emptyDecisionsLog } from './decisionsLog.js'
import { interviewSkillVersions } from './interviewSkills.js'

export const LOG_TOOL_NAME = 'log_decision'
export const LOG_FENCE = 'gantry-log'

/** The tool as the model is told about it. */
export const LOG_TOOL = {
  name: LOG_TOOL_NAME,
  description:
    'Record something in the Stage’s decisions log. kind "fact": the architect told you something in free chat that you used or will use in a Field. ' +
    'Give a short `quote` copied exactly from their message and the `fields` (module.field) it feeds; Gantry keeps THEIR message word for word, never your wording, and ' +
    'refuses anything they did not type. Do not log thanks, "go on" or anything that feeds no Field. kind "open-question": something that stays unanswered, ' +
    'including a select Field where none of the options fits; give the `question`, why it matters in `why`, and the `field` it blocks if any. ' +
    'Answers to question cards are logged by Gantry itself: never log those.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['fact', 'open-question'] },
      quote: { type: 'string', description: 'For a fact: a piece of the architect’s message, copied exactly.' },
      question: { type: 'string', description: 'For an open question: the question, in one sentence.' },
      why: { type: 'string', description: 'For an open question: why it is open or why it matters.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'The Fields this feeds or blocks, each as module.field.' },
    },
    required: ['kind'],
  },
}

/** What a model without tool calling is told, in place of the tool. */
export const LOG_TEXT_FALLBACK_INSTRUCTIONS =
  `To log a fact the architect told you, or an open question, write a fenced code block tagged ${LOG_FENCE} containing JSON such as ` +
  '{"kind":"fact","quote":"copied exactly from their message","fields":["module.field"]} or {"kind":"open-question","question":"...","why":"...","fields":["module.field"]}. ' +
  'Gantry keeps the architect’s own message, never your wording. Never log thanks, "go on" or answers to cards.'

const FENCE = new RegExp('```[ \\t]*' + LOG_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')

/** Removes log blocks from text meant for the screen, including one still being written. */
export function stripLogBlocks(text) {
  const closed = String(text ?? '').replace(FENCE, '')
  const open = closed.search(new RegExp('```[ \\t]*' + LOG_FENCE))
  return (open === -1 ? closed : closed.slice(0, open)).trim()
}

/** The log requests a model wrote as fenced blocks: `{ requests: [{ kind, quote, question, why, fields }], errors }`. */
export function extractLogBlocks(text) {
  const requests = []
  const errors = []
  for (const match of String(text ?? '').matchAll(FENCE)) {
    try {
      const parsed = JSON.parse(match[1])
      const list = Array.isArray(parsed) ? parsed : parsed?.entries ? parsed.entries : [parsed]
      for (const item of list) {
        if (item && (item.kind === 'fact' || item.kind === 'open-question')) requests.push(item)
        else errors.push('A log block needs {"kind": "fact" or "open-question", ...}.')
      }
    } catch (err) {
      errors.push(`A log block is not valid JSON (${err.message}).`)
    }
  }
  return { requests, errors }
}

const squash = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)))

/** `[Brief, p. 4](source:id)` becomes `id, p. 4`: a cited document by id, with its page or slide. */
const sourceRef = (source) => (source?.document ? `${source.document}${source.location ? `, ${source.location}` : ''}` : '')

/**
 * Creates the log collector for one session.
 *
 * @param {object} [config]
 * @param {string} [config.stageId]
 * @param {() => string} [config.now]         an ISO timestamp
 * @param {() => string} [config.newSessionId]
 * @param {() => string} [config.who]         the name stamped on entries (the Instance's assignee)
 */
export function createSessionLog(config = {}) {
  const now = config.now ?? (() => new Date().toISOString())
  let sessionId = (config.newSessionId ?? (() => `s-${Math.random().toString(36).slice(2, 8)}`))()
  const who = () => String(config.who?.() ?? '')
  let committed = []
  let pending = []
  let counter = 0
  const usage = new Map() // `type|model` -> { type, model, inputTokens, cachedTokens, outputTokens }
  let lastAiSave = null

  const all = () => [...committed, ...pending]

  function add(entry) {
    const made = { id: `${sessionId}-${++counter}`, at: now(), session: sessionId, ...(who() ? { who: who() } : {}), ...entry }
    // A later answer on the same thing replaces the earlier one, and answering something closes an open question that waited on it.
    pending.push(made)
    return made
  }

  const currentFor = (kind, test) => currentLogEntries(all()).filter((e) => e.kind === kind && test(e))
  const opensFor = (fields) => currentLogEntries(all()).filter((e) => e.kind === 'open-question' && asList(e.fields).some((f) => fields.includes(f)))
  const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
  const links = (fields, replaced = []) => clean({ replaces: replaced.map((e) => e.id), resolves: opensFor(fields).map((e) => e.id) })

  // Ids are `<session>-<n>`; a session taking over an earlier one carries on after the highest n already in the log.
  const raiseCounter = (entries) => {
    for (const e of entries) {
      const match = String(e.id).match(/-(\d+)$/)
      if (e.session === sessionId && match) counter = Math.max(counter, Number(match[1]))
    }
  }

  return {
    get sessionId() {
      return sessionId
    },

    /**
     * Takes over an earlier session of this architect (a paused one resumed, #290): its id, so the log keeps one status line for the run,
     * and its token totals, so a session resumed in another browser keeps them (#255). Entries not yet sent keep the id they have.
     */
    adopt(status) {
      if (!status?.session || status.session === sessionId) return
      const mine = pending
      sessionId = status.session
      counter = 0
      raiseCounter([...committed, ...mine])
      for (const m of status.models ?? []) {
        if (m?.type && m?.model && typeof m.inputTokens === 'number') {
          usage.set(`${m.type}|${m.model}`, { type: m.type, model: m.model, inputTokens: m.inputTokens ?? 0, cachedTokens: m.cachedTokens ?? 0, outputTokens: m.outputTokens ?? 0 })
        }
      }
      lastAiSave = status.lastAiSave ?? lastAiSave
    },

    /** The log file's entries as committed; entries of this session that the file already holds are no longer pending. */
    load(log) {
      committed = [...(log?.entries ?? [])]
      const have = new Set(committed.map((e) => e.id))
      pending = pending.filter((e) => !have.has(e.id))
      raiseCounter(committed)
    },

    /** Every entry that stands now, committed and pending (oldest first). */
    entries: all,
    committed: () => [...committed],
    pending: () => [...pending],

    /** A question card the architect answered. `card` is the card as answered. */
    addAnswer(card, { round, words, answers, followed }) {
      const fields = card.field ? [card.field] : []
      const replaced = card.field ? currentFor('answer', (e) => asList(e.fields)[0] === card.field && squash(e.question) === squash(card.question)) : []
      return add({
        kind: 'answer',
        ...clean({
          round,
          card: card.id,
          header: card.header,
          question: card.question,
          options: card.options.map((o) => o.label),
          recommendation: card.recommended,
          why: card.why,
          sources: card.source ? [sourceRef(card.source)] : [],
          answer: answers,
          words,
          followed,
          keyDecision: card.kind === 'decision' && card.decision ? true : undefined,
          significance: card.kind === 'decision' && card.decision ? card.decision : undefined,
          fields,
          ...links(fields, replaced),
        }),
      })
    },

    /**
     * A term card the architect answered (#291): the **term choice**. `preferred` is the option chosen (or their own wording) and
     * `avoid` the other names; it replaces an earlier choice about the same thing (one that shares a name), and it feeds the
     * Glossary Field where one is mounted (`fields`). It binds this and every later Stage.
     */
    addTerm(card, { round, words, choice, followed, fields = [] }) {
      const names = new Set([choice.preferred, ...choice.avoid].map(squash))
      const replaced = currentFor('term', (e) => [e.preferred, ...asList(e.avoid)].some((n) => names.has(squash(n))))
      return add({
        kind: 'term',
        ...clean({
          round,
          card: card.id,
          header: card.header,
          question: card.question,
          options: card.options.map((o) => o.label),
          recommendation: card.recommended,
          why: card.why,
          sources: card.source ? [sourceRef(card.source)] : [],
          preferred: choice.preferred,
          avoid: choice.avoid,
          meaning: choice.meaning,
          words,
          followed,
          fields,
          ...links(fields, replaced),
        }),
      })
    },

    /** A fact the architect typed, word for word. Nothing is added when this message already feeds these Fields. */
    addFact(words, fields) {
      const same = currentFor('fact', (e) => e.words === words)
      if (same.some((e) => fields.every((f) => asList(e.fields).includes(f)))) return null
      return add({ kind: 'fact', words, fields, ...links(fields) })
    },

    /**
     * The architect's keep / use / merge choice on saved content. `choice` is 'keep' | 'replace' | 'merge'. `reapproves` (#300, ADR-0069) is
     * the approved earlier Stages that print the Field (`[{ stageId, title }]`): the card said that changing it needs their re-approval with
     * this Stage, and the entry keeps who that was.
     */
    addSavedContent(field, choice, { handEdit = false, reapproves = [] } = {}) {
      const replaced = currentFor('saved-content', (e) => asList(e.fields)[0] === field)
      const stages = reapproves.map((s) => ({ stageId: s.stageId, title: s.title }))
      return add({ kind: 'saved-content', field, choice, ...(handEdit ? { handEdit: true } : {}), ...(stages.length ? { reapproves: stages } : {}), fields: [field], ...links([field], replaced) })
    },

    /**
     * #289: the architect edited a drafted Field by hand in the Interview page's preview. `words` is the text they typed, kept as
     * their own (the AI's wording is never what is stored). A later hand edit of the same Field replaces this one.
     */
    addHandEdit(field, words) {
      const replaced = currentFor('hand-edit', (e) => asList(e.fields)[0] === field)
      return add({ kind: 'hand-edit', field, words: String(words), fields: [field], ...links([field], replaced) })
    },

    addOpenQuestion({ question, why, fields = [] }) {
      const text = String(question ?? '').trim()
      if (!text || currentFor('open-question', (e) => squash(e.question) === squash(text)).length) return null
      return add({ kind: 'open-question', ...clean({ question: text, why: String(why ?? '').trim(), fields }) })
    },

    addArtefact({ artefact, title, candidates }) {
      return add({ kind: 'artefact', ...clean({ artefact, title, candidates }) })
    },

    addRestart() {
      return add({ kind: 'restart', note: 'Start this stage over' })
    },

    /**
     * How the architect settled a Field both they and someone else changed, at a Save (#290, ADR-0068). `choice` is 'mine', 'theirs' or
     * 'merged'; the merged wording is the AI's and is never kept here, only that it was chosen.
     */
    addSaveClash(field, choice, { feeds = true } = {}) {
      const replaced = currentFor('save-clash', (e) => e.field === field)
      return add(clean({ kind: 'save-clash', field, choice, fields: feeds ? [field] : [], ...links([], replaced) }))
    },

    /** Takes back entries that were never sent (a Save that was cancelled after its clash cards were answered). */
    discard(ids) {
      const drop = new Set(ids)
      pending = pending.filter((e) => !drop.has(e.id))
    },

    addModelChange(from, to) {
      return add({ kind: 'model-change', from: { type: from.type, model: from.model }, to: { type: to.type, model: to.model } })
    },

    /** Tokens used by `provider` (an AI Provider as stored: only its type and model are kept). */
    addUsage(provider, used) {
      if (!provider?.type || !provider?.model) return
      const key = `${provider.type}|${provider.model}`
      const line = usage.get(key) ?? { type: provider.type, model: provider.model, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
      line.inputTokens += used.inputTokens ?? 0
      line.cachedTokens += used.cacheReadTokens ?? 0
      line.outputTokens += used.outputTokens ?? 0
      usage.set(key, line)
    },
    usage: () => [...usage.values()].map((u) => ({ ...u })),
    lastAiSave: () => lastAiSave,

    /** What a working copy keeps of the log (#290): the entries not yet committed, the tokens used and the counters. */
    exportState: () => ({ sessionId, pending: pending.map((e) => ({ ...e })), counter, usage: [...usage.values()].map((u) => ({ ...u })), lastAiSave }),
    importState(saved) {
      if (!saved) return
      sessionId = saved.sessionId ?? sessionId
      pending = (saved.pending ?? []).map((e) => ({ ...e }))
      counter = saved.counter ?? counter
      usage.clear()
      for (const u of saved.usage ?? []) usage.set(`${u.type}|${u.model}`, { ...u })
      lastAiSave = saved.lastAiSave ?? null
      raiseCounter([...committed, ...pending])
    },

    /**
     * What the stage Save sends for the log. `fieldInputs` is the session's `module.field -> inputs` and `fieldKeys` the Fields in
     * this Save (the drafts plus those already saved by this session); `handEdited` are those the architect edited by hand. `status` is `{ who, target, state, stages, artefact, instructions }` (`stages`: each Stage of the run and its state, #293).
     */
    delta({ fieldInputs = {}, fieldKeys = [], status = {}, saving = false, handEdited = [] } = {}) {
      if (saving) lastAiSave = now()
      const stands = currentLogEntries(all())
      const fields = {}
      for (const key of fieldKeys) {
        fields[key] = {
          drafted: now(),
          inputs: (fieldInputs[key] ?? []).map((i) => ({ ...i })),
          // A hand-edited Field's record is rebuilt from the edited text (#289): the Source documents it still cites, plus the hand edit.
          entries: stands.filter((e) => asList(e.fields).includes(key) && (!handEdited.includes(key) || e.kind === 'hand-edit')).map((e) => e.id),
        }
      }
      const skills = interviewSkillVersions()
      return {
        status: {
          session: sessionId,
          who: status.who ?? who(),
          target: status.target,
          state: status.state,
          stages: status.stages,
          artefact: status.artefact,
          lastAiSave,
          models: [...usage.values()],
          instructions: status.instructions,
          skills: Object.fromEntries(skills.skills.map((s) => [s.id, s.version])),
        },
        fields,
        entries: pending.map((e) => ({ ...e })),
      }
    },

    /** The Save that carried `delta` worked: its entries are committed. */
    commit(delta) {
      const sent = new Set((delta?.entries ?? []).map((e) => e.id))
      committed = appendEntries({ ...emptyDecisionsLog(), entries: committed }, pending.filter((e) => sent.has(e.id))).log.entries
      pending = pending.filter((e) => !sent.has(e.id))
    },
  }
}
