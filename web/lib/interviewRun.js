// #293 (parent #238, docs/adr/0063 for the remote case; this is the local and server case, which has no approvals; #295 adds the remote
// case below: Azure DevOps and GitHub workspaces, where a Stage moves on only when its Pull Request merges): a **run**
// carries one AI interview across Stages. The architect picks a target Stage at the kickoff ("Run until"); the AI drafts each
// Stage in order, the architect confirms each stage-end card, and the run Saves, advances and starts the next Stage until the
// target Stage's card is confirmed. This file is the run's rules and its record, with no DOM:
//   * the **run plan** the left rail draws: one row per Stage with its state (`planRows`);
//   * what a stage-end Save means for the run, and what the status block of the decisions log records (`saveOutcome`);
//   * working out from the committed decisions logs whether a run was paused or interrupted (`resumableRun`);
//   * the Artefact each Stage of the run aims for, chosen at the kickoff (`artefactRows`, #332);
//   * the run held in this tab, so the Interview page of the next Stage knows it is carrying on (`interviewRuns`).
// The interview of each Stage is its own session (web/lib/interviewSession.js) with its own decisions log; the run is only what
// joins them.
import { signal } from '@preact/signals'
import { artefactChoices } from './interviewBrief.js'

/** The states a row of the run plan can be in. `beyond` is a Stage after the target, which the run never reaches. */
export const PLAN_STATES = Object.freeze(['done', 'drafting', 'drafting-ahead', 'awaiting-confirmation', 'awaiting-approval', 'approval-queued', 'waiting-for-approval', 'waiting', 'paused', 'beyond', 'revising'])

const WORDS = Object.freeze({
  done: 'done',
  drafting: 'drafting',
  'drafting-ahead': 'drafting ahead',
  'awaiting-confirmation': 'awaiting confirmation',
  'awaiting-approval': 'awaiting approval',
  'approval-queued': 'approval queued',
  'waiting-for-approval': 'waiting for approval',
  waiting: 'waiting',
  paused: 'paused',
  beyond: 'beyond target',
  revising: 'revising',
})

/** The plain words for a plan state, as the rail shows them. */
export const planStateWords = (state) => WORDS[state] ?? state

const indexOf = (stages, id) => (stages ?? []).findIndex((s) => s.id === id)

/** The Stages a run can be aimed at from `currentStageId`: that Stage and every one after it, in order. */
export function runTargets(stages, currentStageId) {
  const at = indexOf(stages, currentStageId)
  return at === -1 ? [] : stages.slice(at)
}

/** The Stage after `stageId`, or null at the end of the Definition. */
export function nextStage(stages, stageId) {
  const at = indexOf(stages, stageId)
  return at === -1 ? null : stages[at + 1] ?? null
}

/**
 * The run plan: one row per Stage, in order.
 *
 * @param {object} input
 * @param {{id: string, title: string}[]} input.stages   every Stage of the Instance
 * @param {string} input.currentStageId                   the Stage the interview is on
 * @param {string} input.targetStageId                    the run's target (the current Stage when the run is one Stage)
 * @param {string} [input.instanceStageId]  the Stage the Instance itself is on (#296), when the interview is on a later one (drafting ahead): the Stages from it up to the interview's are not done, they are awaiting approval or queued for it
 * @param {'idle'|'drafting'|'drafting-ahead'|'awaiting-confirmation'|'waiting-for-approval'|'paused'|'done'|'revising'} input.current  where the Stage the interview is on stands (`revising`, #299: the Owner sent it back and the AI is revising it, though its Pull Request is still open)
 * @param {{pullRequests?: Record<string, {id: number|string, url?: string|null}>, queued?: Record<string, boolean>, headStart?: Record<string, boolean>}} [input.remote]
 *   a Provider workspace's record (#295): the Pull Requests open for approval, by Stage, the Stages queued for it, and (#296) the later Stages
 *   holding a saved head start. The Provider's word overrides the log's: a Stage with a Pull Request open is awaiting approval, and a later
 *   Stage that is queued shows Approval queued.
 * @returns {{id: string, title: string, state: string, target: boolean, note: string, pullRequest: {id: number|string, url: string|null}|null, checkable: boolean}[]}
 */
export function planRows({ stages, currentStageId, targetStageId, current = 'idle', remote = null, instanceStageId = currentStageId }) {
  const currentAt = indexOf(stages, currentStageId)
  const instanceAt = Math.min(indexOf(stages, instanceStageId) === -1 ? currentAt : indexOf(stages, instanceStageId), currentAt)
  const targetAt = Math.max(indexOf(stages, targetStageId), currentAt)
  return (stages ?? []).map((stage, at) => {
    const open = remote?.pullRequests?.[stage.id] ?? null
    const idleWord = remote?.queued?.[stage.id] ? 'approval-queued' : remote?.headStart?.[stage.id] ? 'waiting-for-approval' : 'waiting'
    let state
    if (at > targetAt) state = 'beyond'
    // #296: a Stage before the interview's that the Instance has not moved past is pending, not done: its Pull Request is open, or it is queued behind one.
    else if (at < currentAt) state = at < instanceAt ? 'done' : open || at === instanceAt ? 'awaiting-approval' : 'approval-queued'
    else if (at === currentAt) state = current === 'revising' ? 'revising' : open ? 'awaiting-approval' : current === 'idle' ? idleWord : current
    else state = open ? 'awaiting-approval' : idleWord
    const target = at === targetAt
    const pullRequest = state === 'awaiting-approval' && open ? { id: open.id, url: open.url ?? null } : null
    return {
      id: stage.id,
      title: stage.title,
      state,
      target,
      note: target && state !== 'beyond' ? `${planStateWords(state)} · target` : planStateWords(state),
      pullRequest,
      // Clicking an "awaiting approval" row runs Check status (ADR-0063); nothing else on the plan is a button.
      checkable: state === 'awaiting-approval',
    }
  })
}

/**
 * What confirming the stage-end card does to the run.
 *
 * @param {object} input
 * @param {{id: string}[]} input.stages
 * @param {string} input.currentStageId
 * @param {string} input.targetStageId
 * @param {string} input.startStageId  the Stage the run began on
 * @param {'advance'|'stop'|'approval'|'head-start'} input.action  "Save, advance, carry on" (a local or server workspace), "Save and stop here",
 *   "Save, request approval, draft ahead" (a remote workspace, #295), or the Waiting card's save of the head start (#296)
 * @param {string} [input.instanceStageId]  the Stage the Instance is on, when the Save is of a Stage drafted ahead of it (#296): the Stages from it up to this one are awaiting approval
 * @param {boolean} [input.queued]  the Stage is not the Instance's current one, so its approval can't be asked for yet and is queued (#295)
 * @returns {{state: string, finished: boolean, advances: boolean, requestsApproval: boolean, nextStageId: string|null, stages: Record<string, string>}}
 *   `state` is the Stage's state in the status block; `stages` is each Stage of the run and its state, which the same Save records.
 *   A remote Stage never advances by itself: `requestsApproval` says the Save is followed by a request for approval (or, queued, by a wait),
 *   and the Stage is `awaiting-approval` (`approval-queued`) until a Check status sees its Pull Request merge. At the target Stage the run is
 *   done, whatever the Owner's answer: the session has nothing more to draft.
 */
export function saveOutcome({ stages, currentStageId, targetStageId, startStageId, action, queued = false, instanceStageId = currentStageId }) {
  const currentAt = indexOf(stages, currentStageId)
  const instanceAt = Math.min(indexOf(stages, instanceStageId) === -1 ? currentAt : indexOf(stages, instanceStageId), currentAt)
  const targetAt = Math.max(indexOf(stages, targetStageId), currentAt)
  const startAt = Math.min(indexOf(stages, startStageId) === -1 ? currentAt : indexOf(stages, startStageId), currentAt)
  const finished = currentAt >= targetAt
  const approval = action === 'approval'
  const advances = !finished && action === 'advance'
  const waitWord = queued ? 'approval-queued' : 'awaiting-approval'
  // #296: the Waiting card saves the head start of a Stage drafted ahead: it is not finished, it waits for the earlier Stage's approval.
  const headStart = action === 'head-start'
  // A Stage queued behind an earlier one is not done at the target: its Pull Request still has to open (#296), so the log says so.
  const state = headStart ? 'head-start' : finished ? (approval && queued ? waitWord : 'done') : approval ? waitWord : action === 'advance' ? 'saved' : 'paused'
  const map = {}
  for (let at = startAt; at <= targetAt; at++) {
    const id = stages[at].id
    if (at < currentAt) map[id] = at < instanceAt ? 'done' : at === instanceAt ? 'awaiting-approval' : 'approval-queued'
    else if (at === currentAt) map[id] = headStart ? 'head-start' : approval ? waitWord : finished || advances ? 'done' : 'paused'
    else map[id] = 'waiting'
  }
  return { state, finished, advances, requestsApproval: approval, nextStageId: advances ? stages[currentAt + 1]?.id ?? null : null, stages: map }
}

// The states a Stage's last Save can leave a run in with more of it to do: saved and meant to advance, paused, or (remote) waiting for approval.
const HALF_WAY = new Set(['paused', 'saved', 'awaiting-approval', 'approval-queued'])

// The newest status entry of a decisions log (the last session to Save), or null.
const latestStatus = (log) => (Array.isArray(log?.status) && log.status.length ? log.status[log.status.length - 1] : null)

/**
 * Whether a run was left part-way, from the committed decisions logs of the current Stage and the one before it.
 *
 *   * `advance`: the current Stage was saved with "Save and stop here" (`paused`), or with "Save, advance, carry on" but never advanced
 *     (`saved`). Resuming advances it, then interviews the next Stage.
 *   * `continue`: the run Saved and advanced out of the previous Stage (`saved`), or paused there, and this Stage is where it stands.
 *     Resuming interviews this Stage.
 *
 * A run whose target is the Stage it was on, or one that finished (`done`), is not left part-way.
 *
 * On a remote workspace (#295) a Stage waiting for approval (`awaiting-approval`) counts as saved: once the Owner's approval has been seen
 * the Instance is on the next Stage, whose log is empty, and the run `continue`s there. `advance` there means "ask for approval, then wait",
 * and is offered only when no Pull Request is open for the Stage: the Provider's word (`openPullRequests`, by Stage id) overrides the log.
 *
 * @param {{stages: {id: string, title: string}[], currentStageId: string, logs: Record<string, object|null>, openPullRequests?: Record<string, unknown>}} input
 *   `logs` maps a Stage id to its committed decisions log (only the current and the previous Stage are looked at).
 * @returns {{mode: 'advance'|'continue', targetStageId: string, fromStageId: string}|null}
 */
export function resumableRun({ stages, currentStageId, logs = {}, openPullRequests = {} }) {
  const currentAt = indexOf(stages, currentStageId)
  if (currentAt === -1) return null
  const here = latestStatus(logs[currentStageId])
  // A Pause (#290) also writes `paused`, but leaves this Stage "in-progress" in the run's map: that Stage is not finished, so there is
  // nothing to advance past, and the Interview page resumes it as a paused session instead.
  const stopped = (status, stageId) => HALF_WAY.has(status?.state) && status.stages?.[stageId] !== 'in-progress'
  if (stopped(here, currentStageId) && indexOf(stages, here.target) > currentAt && !openPullRequests[currentStageId]) {
    return { mode: 'advance', targetStageId: here.target, fromStageId: currentStageId }
  }
  const before = currentAt > 0 ? stages[currentAt - 1].id : null
  const was = before ? latestStatus(logs[before]) : null
  if (was && stopped(was, before) && indexOf(stages, was.target) >= currentAt && !here) {
    return { mode: 'continue', targetStageId: was.target, fromStageId: before }
  }
  return null
}

/**
 * The Stage a run began on, from the `stages` map the run's last Save wrote into its status block (#293): the earliest of the Stages it
 * names. `fallback` when the log names none. A run resumed in another browser takes its start from here, so its session total (#294)
 * still adds up the Stages it already went through.
 */
export function runStartStage(stages, log, fallback) {
  const named = Object.keys(latestStatus(log)?.stages ?? {})
    .map((id) => indexOf(stages, id))
    .filter((at) => at !== -1)
  return named.length ? stages[Math.min(...named)].id : fallback
}

/**
 * The opening message the run was started with (#331), from the status block its last Save wrote: '' when the architect typed none. A run
 * resumed in another browser takes it from here, so each Stage it reaches still starts with the same words.
 */
export function runOpening(log) {
  return latestStatus(log)?.opening ?? ''
}

/**
 * The kickoff's "Artefact for each Stage" (#332): one row per Stage of the run, from the current Stage to the target, in order. Each row has the
 * Artefacts that can pass that Stage's Gate and the one the Stage aims for: the architect's pick, else the one the run already chose for it (the
 * run in this tab, or the status block of its last Save), else the lightest. A pick that can't pass the Gate is not used. A Stage with no
 * candidate has no Artefact to aim for, and its interview goes as it did before there was a choice.
 *
 * @param {object} input
 * @param {object} input.definition  the Definition, with `stages` (each with its `gate`) and `artefacts`
 * @param {{id: string, title?: string, gate?: string}[]} input.stages  every Stage of the Instance
 * @param {string} input.currentStageId
 * @param {string} input.targetStageId  the run's target (the current Stage, or none ahead of it, is a run of one Stage)
 * @param {Record<string, string>} [input.picked]  what the architect chose on this kickoff, by Stage id
 * @param {Record<string, string>} [input.remembered]  what the run already chose, by Stage id
 * @returns {{id: string, title: string, gate: string, candidates: object[], lightest: object|null, chosen: object|null}[]}
 */
export function artefactRows({ definition, stages, currentStageId, targetStageId, picked = {}, remembered = {} }) {
  const currentAt = indexOf(stages, currentStageId)
  if (currentAt === -1) return []
  const targetAt = Math.max(indexOf(stages, targetStageId), currentAt)
  return stages.slice(currentAt, targetAt + 1).map((stage) => {
    const { candidates, lightest } = artefactChoices(definition, stage.id)
    const candidate = (id) => candidates.find((a) => a.id === id)
    const gate = stage.gate ?? (definition?.stages ?? []).find((s) => s.id === stage.id)?.gate ?? ''
    return { id: stage.id, title: stage.title ?? stage.id, gate, candidates, lightest, chosen: candidate(picked[stage.id]) ?? candidate(remembered[stage.id]) ?? lightest }
  })
}

/** The Artefact each row aims for, by Stage id: what the run record and the status block keep (#332). A Stage with none is left out. */
export const chosenArtefacts = (rows) => Object.fromEntries(rows.filter((row) => row.chosen).map((row) => [row.id, row.chosen.id]))

/**
 * The Artefact chosen for each Stage of the run (#332), from the status block its last Save wrote on `stageId`: `{}` when it names none. A log
 * written before there was a choice per Stage still says what this Stage aimed for. A run, or a paused session, resumed in another browser
 * takes them from here.
 */
export function runArtefacts(log, stageId) {
  const status = latestStatus(log)
  if (!status) return {}
  return { ...(status.artefacts ?? {}), ...(stageId && status.artefact ? { [stageId]: status.artefact } : {}) }
}

/**
 * The Artefact each Stage aims for when **Resume the run** carries a paused run on (#332): what the run chose, from the status block of
 * `fromStageId` (the Stage it was paused on), unless the architect chose another on this kickoff. The kickoff is between sessions, so its rows
 * can be changed there, as Run until can; while a session is running they can't. A Stage the run never chose for (Run until now reaches it)
 * aims for its lightest, and the Stages behind this one keep the run's choice.
 */
export function resumedArtefacts({ definition, stages, currentStageId, targetStageId, picked = {}, log, fromStageId }) {
  const chose = runArtefacts(log, fromStageId)
  return { ...chose, ...chosenArtefacts(artefactRows({ definition, stages, currentStageId, targetStageId, picked, remembered: chose })) }
}

// ---------- the run held in this tab ----------

/**
 * The runs in this tab, by Instance slug. A run is what the Interview page of the next Stage reads to know it is carrying on:
 * `{ target, startStageId, providerId, phase: 'running'|'paused'|'done', carryOn: stageId|null, opening, artefacts }`. `opening` (#331) is the
 * architect's opening message from the kickoff, which every Stage of the run starts with ('' for none). `artefacts` (#332) is the Artefact
 * chosen for each Stage of the run, by Stage id, which that Stage aims for when the run reaches it.
 */
export const interviewRuns = signal({})

export function getRun(slug) {
  return interviewRuns.value[slug] ?? null
}

/** Starts (or replaces) the run for `slug`. */
export function beginRun(slug, run) {
  interviewRuns.value = { ...interviewRuns.value, [slug]: { carryOn: null, phase: 'running', ...run } }
}

/** Changes the run for `slug`; nothing happens if there is none. */
export function updateRun(slug, patch) {
  const run = interviewRuns.value[slug]
  if (!run) return
  interviewRuns.value = { ...interviewRuns.value, [slug]: { ...run, ...patch } }
}

export function clearRun(slug) {
  if (!(slug in interviewRuns.value)) return
  const { [slug]: _gone, ...rest } = interviewRuns.value
  interviewRuns.value = rest
}
