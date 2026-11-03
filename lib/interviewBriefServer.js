import { readFileSync } from 'node:fs'
import { buildInterviewBrief, BRIEF_PARTS } from '../web/lib/interviewBrief.js'
import { OUTSIDE_AGENT, currentLogEntries, openQuestions } from '../web/lib/decisionsLog.js'
import { heldModules, isDraftingAhead, withHeldModules } from '../web/lib/draftAhead.js'
import { reopenOutlook } from '../web/lib/bringUpToDate.js'
import { approvedPrintedFields } from '../web/lib/interviewReapproval.js'
import { resumeInfo } from '../web/lib/interviewResume.js'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { SESSION_STATES } from './outsideAgentSession.js'
import { instanceTargetSize } from '../web/lib/instanceSettings.js'

// #307 (map #238, docs/adr/0067): the **interview brief** for an outside agent over MCP. It is the brief the in-app AI gets, built by the same
// builder (web/lib/interviewBrief.js) from the same inputs, so the agent follows exactly the same rules, skills, Interview instructions,
// Field guidance, saved content, Source documents and decisions log. This file only gathers those inputs on the server, from whichever
// workspace kind holds the Instance, and adds what the in-app page works out for itself: a recap of the Stage's log (web/lib/interviewResume.js).
// The reads (saved content, Source documents, logs) are handed in, so every workspace kind shares this.

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
let skillsPromise = null
/** The bundled grilling and domain-modeling skills, read from disk once. */
export const loadSkillsOnServer = () => (skillsPromise ??= loadInterviewSkills(async (path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8')))

/**
 * What the brief says about opening a catalogued document: an outside agent has the `read_source_document` MCP tool, which takes a page, not
 * the Interview page's character range. A picture or a scanned PDF it opens with the same tool (a picture comes back as a picture).
 */
const READER_TEXT =
  'Read a document, or part of one, with the `read_source_document` tool (its `id`, and a `page` from 1: a PDF\'s own pages, anything else in runs of about 20,000 characters) before relying on or citing it. ' +
  'Fields you draft from a document you read cite it by its id; Gantry notes the citation as an input of the Field, so the Field is flagged Out of date if the document changes.'

/** How an outside agent runs the interview, from its own chat. It follows the brief; this says what is different for an agent. */
export const OUTSIDE_AGENT_NOTE = [
  'You are an outside agent running this interview over the Gantry MCP server. The brief above is the one Gantry\'s own AI follows, and you follow it the same way, with these differences.',
  '',
  '- Ask your questions in your own chat. Question cards are web-only. Ask a round at a time; for each question give your recommendation, a one-line reason and the Source document it rests on, as the rules say. Every answer is the architect\'s own: never answer for them.',
  '- Draft in your head or in your own working notes. Nothing is written until the architect confirms the stage summary (or asks you to pause), so there is no commit per answer.',
  '- Keep the list of entries to record as you go: what the architect answered (`answer`), facts they told you in their own words (`fact`, with `words` copied exactly as they typed them), open questions (`open-question`), term choices (`term`), their keep / replace / merge choice on saved content (`saved-content`), and their answer for each Out of date Field (`source-update`: keep, redraft, redraft-without, re-cite or open-question). Each names the Fields it feeds as `module.field`.',
  '- Save at the stage-summary confirm with `update_instance_modules`: the modules, the `stageVersion` get_instance gave you (required in a session), the `session` (the id you were given, the state `saved` if the architect chose to carry on to the next Stage or `in-progress`/`done` otherwise) and your `entries`. Gantry stamps each entry "recorded by an outside agent", names your model in the session status (tokens "not reported"), and rebuilds the Fields section from your citations and entries, all in one commit with the content.',
  '- Pause with `pause_interview_session` when the architect asks, or when you cannot carry on: it saves the entries and any drafts you hold in one commit. The architect can resume in the browser or you can resume with `resume_interview_session`; whoever resumes recaps from the committed log, and the log wins over anything you remember.',
  '- You never pass a Gate. On a workspace whose Stages move on by Pull Request, request approval strictly in Stage order and wait for the Owner (`check_status`); do not write a Module a pending earlier Stage also mounts. Gantry refuses these in a session, with the reason.',
  '- The brief lists signed-off Stages you may offer to re-open. Offer one only in your chat, and re-open it with `reopen_stage` only when the architect says so. The Owner\'s comments on a Pull Request, when a Stage is sent back, are read with the Provider; Gantry never writes to the Pull Request for you.',
  '- Content you write stays `draft`; only a person marks a Module `agreed`.',
].join('\n')

const stageStateWords = new Set(SESSION_STATES)

// A status line as an agent (or a person) reads it.
function sessionLine(status) {
  return {
    session: status.session,
    who: status.who || '',
    state: stageStateWords.has(status.state) ? status.state : status.state || 'in-progress',
    target: status.target ?? null,
    lastAiSave: status.lastAiSave ?? null,
    recordedBy: status.recordedBy ?? null,
    models: (status.models ?? []).map((m) => ({ type: m.type, model: m.model, tokens: m.tokens ?? { input: m.inputTokens ?? 0, cached: m.cachedTokens ?? 0, output: m.outputTokens ?? 0 } })),
  }
}

/**
 * The brief for `stageId` (the Instance's current Stage when omitted), and the recap of its log.
 *
 * @param {object} input
 * @param {object} input.definition        the loaded Definition (`modules` a Map, standard modules mounted)
 * @param {object} input.instance          the Instance record (`stage` is its current Stage; `size`, `pullRequests`)
 * @param {boolean} input.workspaceBacked  an Azure DevOps or GitHub workspace, where Stages move on by Pull Request
 * @param {(stage: object) => Promise<{id: string, fields: {id: string, value: any}[]}[]>} input.readStageModules
 * @param {{list: () => Promise<{entries: object[]}>, readText: (id: string) => Promise<string|null>}} input.sourceStore
 * @param {(stageId: string) => Promise<object|null>} input.readLog   a Stage's committed decisions log
 * @param {string} [input.who]             who is interviewing, so a paused session of theirs can be taken over
 * @param {string} [input.stageState]      what Check status reported for this Stage (it overrides the log)
 * @param {{by: string, at: string}|null} [input.lastSaved]  who last saved the Stage on the Provider
 * @param {boolean} [input.currentStageStarted]  whether the Instance's current Stage has a branch on the Provider
 */
export async function describeInterviewBrief({ definition, instance, stageId, artefactId, workspaceBacked = false, currentStageStarted = false, readStageModules, sourceStore, readLog, who = '', stageState = null, lastSaved = null }) {
  const stages = definition.stages
  const targetId = stageId ?? instance.stage
  const stage = stages.find((s) => s.id === targetId)
  if (!stage) throw Object.assign(new Error(`Definition "${definition.id}" has no stage "${targetId}"`), { status: 400 })

  const skills = await loadSkillsOnServer()
  const logList = await Promise.all(stages.map((s) => readLog(s.id).catch(() => null)))
  const logs = Object.fromEntries(stages.map((s, i) => [s.id, logList[i]]))

  // A Stage drafted ahead of the Instance's current one gets a head start only (docs/adr/0063): the Modules an earlier, pending Stage also mounts are held.
  const held = workspaceBacked ? heldModules(stages, stage.id, instance.stage) : []
  const heldIds = new Set(held.map((h) => h.id))
  const definitionNow = withHeldModules(definition, stage.id, held)

  // Saved content, the way the Interview page gathers it: the Modules of every other Stage, then this Stage's own (a held Module is the earlier Stage's).
  const byModule = new Map()
  for (const other of stages) {
    if (other.id === stage.id) continue
    for (const m of await readStageModules(other)) byModule.set(m.id, m)
  }
  for (const m of await readStageModules(stage)) if (!heldIds.has(m.id) || !byModule.has(m.id)) byModule.set(m.id, m)

  // Source documents with the text read out of each (the brief puts the text in whole, or catalogues it when the pack is big).
  const { entries: manifest } = await sourceStore.list()
  const sources = []
  for (const entry of manifest) {
    if (entry.removedAt || !entry.text) {
      sources.push(entry)
      continue
    }
    let text
    try {
      text = (await sourceStore.readText(entry.id)) ?? undefined
    } catch {
      // an unreadable text is left out; the brief lists the document as having none
    }
    sources.push(text ? { ...entry, text } : { ...entry, text: undefined })
  }
  // A document with no text is opened by the agent with its tool (a picture comes back as a picture, a scan as its pages).
  const sourceAccess = Object.fromEntries(
    sources.filter((s) => !s.removedAt && !(typeof s.text === 'string' && s.text.trim())).map((s) => [s.id, { how: 'tool', kind: /\.pdf$/i.test(s.filename ?? '') ? 'pdf' : /\.(png|jpe?g|gif|webp)$/i.test(s.filename ?? '') ? 'image' : 'document' }])
  )

  const at = stages.findIndex((s) => s.id === stage.id)
  const earlierDecisions = stages
    .slice(0, Math.max(0, at))
    .map((s) => ({ stageId: s.id, stageTitle: s.title ?? s.id, entries: logs[s.id]?.entries ?? [] }))
    .filter((l) => l.entries.length)
  // #300 (docs/adr/0069): on a workspace with approvals, the Fields an approved earlier Stage prints are approved content.
  const approvedPrinted = approvedPrintedFields({
    definition: definitionNow,
    instance: { workspaceBacked, stages: stages.map((s) => ({ id: s.id, title: s.title })), stage: { id: stage.id }, currentStageId: instance.stage, pullRequests: instance.pullRequests ?? {}, changedSinceApproval: [] },
  })

  // #299 (ADR-0026): the signed-off Stages the AI may offer to re-open, and those Gantry would refuse right now. Judged as the Interview page judges it: a Stage
  // counts as started when it is the current one or later and has a Pull Request open or a decisions log that has saved.
  const currentAt = stages.findIndex((s) => s.id === instance.stage)
  const logHasSaved = (l) => Boolean(l) && (Object.keys(l.fields ?? {}).length > 0 || (Array.isArray(l.status) && l.status.some((st) => st?.lastAiSave)))
  const started = stages
    .filter((st, i) => i >= currentAt && (instance.pullRequests?.[st.id] || (st.id === instance.stage && currentStageStarted) || logHasSaved(logs[st.id])))
    .map((st) => st.id)
  const reopenable =
    workspaceBacked && !isDraftingAhead(stages, stage.id, instance.stage)
      ? stages.slice(0, Math.max(0, currentAt)).map((st) => ({ id: st.id, title: st.title, ...reopenOutlook({ stages, currentStageId: instance.stage, targetId: st.id, inProgress: started }) }))
      : []

  const log = logs[stage.id]
  const brief = buildInterviewBrief({
    definition: definitionNow,
    stageId: stage.id,
    artefactId,
    size: instanceTargetSize(definition, instance),
    saved: [...byModule.values()],
    decisions: log,
    earlierDecisions,
    sources,
    skills,
    // The agent's own window is not known here. The Interview page's default is what a Provider with no stated window gets, and a pack that big is catalogued.
    readerTool: true,
    readerText: READER_TEXT,
    sourceAccess,
    approvedPrinted,
    reopenable,
  })

  const providerStates = {}
  if (stageState) providerStates[stage.id] = stageState
  const resume = resumeInfo({
    logs,
    stageId: stage.id,
    stageTitle: stage.title,
    actor: who,
    providerStates,
    stages,
    fieldTitle: (key) => {
      const [moduleId, ...rest] = key.split('.')
      const field = definition.modules.get(moduleId)?.fields?.find((f) => f.id === rest.join('.'))
      return field?.title ?? key
    },
  })
  const open = openQuestions(log).map((e) => ({ id: e.id, question: e.question, why: e.why ?? null, fields: e.fields ?? [] }))
  const standing = currentLogEntries(log)
  const statuses = (log?.status ?? []).map(sessionLine)
  // With no name given, the most recent Pause on the Stage is the one to take over (a session carries the name of whoever ran it).
  const latestPause = who ? null : [...statuses].filter((s) => s.state === 'paused').sort((a, b) => String(b.lastAiSave ?? '').localeCompare(String(a.lastAiSave ?? '')))[0] ?? null

  return {
    stage: brief.stage,
    artefact: brief.artefact,
    candidates: brief.candidates,
    // The brief, exactly as the in-app AI gets it: `text` is all nine parts in precedence order; `stableText` is parts 1-8 (the same on every turn) and `turnText` part 9.
    brief: brief.text,
    parts: BRIEF_PARTS.map(({ order, id, title, stable }) => ({ order, id, title, stable })),
    fields: brief.fields,
    sources: brief.sources,
    rulesVersion: brief.rulesVersion,
    skills: brief.skills,
    tokens: brief.tokens,
    heldModules: held,
    recap: {
      resuming: resume.resuming,
      line: resume.recap || `Starting ${stage.title ?? stage.id}: nothing is logged for this Stage yet.`,
      decisions: standing.filter((e) => !['open-question', 'model-change', 'artefact'].includes(e.kind)).length,
      openQuestions: open,
      sessions: statuses,
      // A paused session to take over (the most recent Pause of this architect's, matched on `who`); what is still going on the Stage; the earlier Stages' logs.
      adoptable: resume.adopt ? sessionLine(resume.adopt) : latestPause,
      others: resume.others,
      earlier: resume.earlier,
      stageState: resume.stageState,
      lastSaved,
      recordedByOutsideAgent: standing.filter((e) => e.recordedBy === OUTSIDE_AGENT).length,
    },
    instructions: OUTSIDE_AGENT_NOTE,
  }
}
