// An outside agent running an AI interview session over MCP — ticket #307, docs/adr/0067 (with 0063, 0064 and 0068). The agent asks its
// questions in its own chat; these tools give it the same brief the in-app AI follows, a session it can start, pause and resume (alone or
// moving to and from the browser through the last commit), and the Review response list. The rules live in `gantry serve` (the brief,
// the guard rails, the labelled log entries, the per-Field check); every tool here is a thin call to one of its routes.
//
// Saving is `update_instance_modules` (instanceContent.tools.js), which takes the session and the entries; advance_stage and
// request_approval take the session id so Gantry can hold the agent to the in-app AI's rules.

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { resolveInstanceWorkspace } from '../gantryClient.js'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'
import { sessionShape, updateInstanceModules } from './instanceContent.tools.js'

async function resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient }) {
  if (!slug && !ref) {
    return { errorResult: errorResult('Provide "slug" or "ref" to identify the instance.') }
  }
  const res = await resolveInstanceWorkspace({ gantryClient, slug, scope, ref })
  if (!res.ok) return { errorResult: upstreamErrorResult(res) }
  return { workspaceId: res.body?.workspaceId, scope: res.body?.scope }
}

const slugRefShape = {
  slug: z.string().optional().describe('The instance slug. Provide this or "ref".'),
  scope: z.string().optional().describe('The opaque workspace-scope token GET /api/instance/workspace or a prior instance lookup returned. Pins the lookup to one workspace when a bare slug is ambiguous.'),
  ref: z.string().optional().describe('The instance\'s numeric reference (e.g. "w1i2"), as an alternative to "slug".'),
}

// One call to a gantry serve route for the instance: `{ res }` to read, or `{ result }` (already shaped for return) when the instance could
// not be resolved, a credential is missing or gantry serve refused.
async function callInstanceRoute(args, { gantryClient }, { path, method, query, body }) {
  const { slug, scope, ref } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return { result: resolved.errorResult }
  const res = await gantryClient.request({ workspaceId: resolved.workspaceId, path, method, query: { slug, scope: scope ?? resolved.scope, ref, ...query }, body })
  if (res.credentialError) return { result: credentialErrorResult(res.credentialError) }
  if (!res.ok) return { result: upstreamErrorResult(res) }
  return { res }
}

const newSessionId = () => `s-${randomBytes(3).toString('hex')}`

// What the agent is handed back for a session it is in: exactly what update_instance_modules, pause_interview_session, advance_stage and
// request_approval take as "session" (or its id).
function sessionHandle({ id, runUntil, who, model }) {
  return { id, runUntil, state: 'in-progress', ...(model ? { model } : {}), ...(who ? { who } : {}) }
}

const stageIndex = (stages, id) => stages.findIndex((s) => s.id === id)

// The Stage's brief and recap, with the version an agent saves against.
async function readBriefFor(args, context, { stage, stageState } = {}) {
  const { res: instanceRes, result: instanceError } = await callInstanceRoute(args, context, { path: '/api/instance', query: { stage } })
  if (instanceError) return { result: instanceError }
  const instance = instanceRes.body
  const { res, result } = await callInstanceRoute(args, context, {
    path: '/api/instance/interview-brief',
    query: { stage: stage ?? instance.stage?.id, artefact: args.artefactId, who: args.who, stageState },
  })
  if (result) return { result }
  return { instance, brief: res.body }
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

async function getInterviewBrief(args, context) {
  const got = await readBriefFor(args, context, { stage: args.stage })
  if (got.result) return got.result
  return okResult({ stageVersion: got.instance.stageVersion, ...got.brief })
}

// ---------------------------------------------------------------------------
// Sessions: start, pause, resume
// ---------------------------------------------------------------------------

function notesFor(brief) {
  const notes = []
  const others = brief.recap?.others ?? []
  if (others.length) {
    notes.push(
      `Another session on this stage is not done: ${others.map((o) => `${o.session}${o.who ? ` (${o.who})` : ''}, ${o.state}`).join('; ')}. Tell the architect, and carry on alongside it only if they say so: Gantry settles any clash Field by Field at each save.`
    )
  }
  if ((brief.heldModules ?? []).length) {
    notes.push(
      `This stage is being drafted ahead of the instance's current stage, so it gets a head start only: ${brief.heldModules.map((h) => h.id).join(', ')} wait until "${brief.heldModules[0].stageTitle}" is approved and merged. Gantry refuses a write to them until then.`
    )
  }
  return notes
}

async function startInterviewSession(args, context) {
  const { runUntil, stage, model, who } = args
  const got = await readBriefFor(args, context, { stage })
  if (got.result) return got.result
  const stages = got.instance.stages ?? []
  const target = stage ?? got.instance.stage?.id
  const goal = runUntil ?? target
  if (stageIndex(stages, goal) === -1) return errorResult(`"runUntil" must be a stage id of this instance: ${stages.map((s) => s.id).join(', ')}.`)
  if (stageIndex(stages, goal) < stageIndex(stages, target)) return errorResult(`"runUntil" (${goal}) comes before the stage being interviewed (${target}). A run goes forward.`)
  return okResult({
    session: sessionHandle({ id: newSessionId(), runUntil: goal, who, model }),
    stageVersion: got.instance.stageVersion,
    currentStageId: got.instance.currentStageId ?? got.instance.stage?.id,
    workspaceBacked: Boolean(got.instance.workspaceBacked),
    notes: notesFor(got.brief),
    ...got.brief,
    next: 'Read the Source documents the brief lists, draft what they support, then interview the architect in your own chat. Nothing is saved until they confirm the stage summary (update_instance_modules with this session) or ask to pause (pause_interview_session).',
  })
}

async function resumeInterviewSession(args, context) {
  const { runUntil, stage, model, who, session: wanted } = args
  // Whichever side resumes runs Check status once (a workspace whose stages move on by Pull Request), and what it reports wins over the log.
  const first = await callInstanceRoute(args, context, { path: '/api/instance', query: { stage } })
  if (first.result) return first.result
  let checkStatus = { ran: false }
  let stageState
  const instance = first.res.body
  if (instance.workspaceBacked && instance.pullRequests?.[instance.currentStageId ?? instance.stage?.id]) {
    const checked = await callInstanceRoute(args, context, { path: '/api/instance/check-status', method: 'POST', body: {} })
    if (checked.result) {
      checkStatus = { ran: true, error: JSON.parse(checked.result.content[0].text) }
    } else {
      const body = checked.res.body
      checkStatus = { ran: true, merged: Boolean(body?.merged), message: body?.message ?? null, advancedTo: body?.advancedTo ?? null, review: body?.review?.state ?? null }
      if (body?.merged) stageState = 'advanced'
    }
  }
  // A merge moved the instance on: the stage to carry on with is the new current one.
  const got = await readBriefFor(args, context, { stage: checkStatus.merged ? undefined : stage, stageState: checkStatus.merged ? undefined : stageState })
  if (got.result) return got.result
  const stages = got.instance.stages ?? []
  const recap = got.brief.recap ?? {}
  const adopted = (wanted ? (recap.sessions ?? []).find((s) => s.session === wanted) : null) ?? recap.adoptable ?? null
  const goal = runUntil ?? adopted?.target ?? got.brief.stage?.id
  if (stageIndex(stages, goal) === -1) return errorResult(`"runUntil" must be a stage id of this instance: ${stages.map((s) => s.id).join(', ')}.`)
  return okResult({
    session: sessionHandle({ id: adopted?.session ?? newSessionId(), runUntil: goal, who: who ?? adopted?.who, model }),
    adopted: Boolean(adopted),
    checkStatus,
    stageVersion: got.instance.stageVersion,
    currentStageId: got.instance.currentStageId ?? got.instance.stage?.id,
    workspaceBacked: Boolean(got.instance.workspaceBacked),
    notes: notesFor(got.brief),
    ...got.brief,
    next: `Open with the recap (${JSON.stringify(recap.line ?? '')}) in one short line, then ask the next round. You do not have the earlier conversation: the brief holds the saved content and the decisions log, and the committed log wins over anything you remember. Do not ask again what the log settles.`,
  })
}

async function pauseInterviewSession(args, context) {
  const { session, modules, entries } = args
  const pausing = { ...session, state: 'paused' }
  if (modules && Object.keys(modules).length) {
    // The drafts held so far are saved with the entries in one commit, against the stage version.
    const result = await updateInstanceModules({ ...args, session: pausing }, context)
    if (result.isError) return result
    const saved = JSON.parse(result.content[0].text)
    return okResult({ paused: true, session: saved.session, stageVersion: saved.stageVersion, commit: saved.commit ?? null, fieldNotes: saved.fieldNotes ?? [] })
  }
  const { res, result } = await callInstanceRoute(args, context, {
    path: '/api/instance/decisions',
    method: 'PUT',
    query: { stage: args.stage },
    body: { session: pausing, ...(entries ? { entries } : {}) },
  })
  if (result) return result
  return okResult({ paused: true, session: res.body?.session, note: 'The entries and the session status were saved on their own, in one commit. Resume from the browser or with resume_interview_session.' })
}

// ---------------------------------------------------------------------------
// After a review round
// ---------------------------------------------------------------------------

async function getReviewResponseList(args, context) {
  const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/review-response' })
  if (result) return result
  return okResult(res.body)
}

async function recordReviewAnswers(args, context) {
  const { answered } = args
  if (!answered || Object.keys(answered).length === 0) return errorResult('Provide "answered": { <reviewId>: <number of comments answered> }.')
  const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/reviews/answered', method: 'PUT', body: { answered } })
  if (result) return result
  return okResult({ reviewedCopies: res.body?.reviews ?? [] })
}

export const tools = [
  {
    name: 'get_interview_brief',
    description:
      '1. Returns the interview brief the in-app AI gets for one stage, built by the same code from the same inputs, plus a recap of the stage\'s decisions log. Follow it as Gantry\'s own AI does. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". "stage" (a stage id) briefs a stage other than the instance\'s current one; "artefactId" is the artefact aimed for (without it the brief says which candidates there are and you ask). ' +
      '3. "brief" is nine parts in precedence order, the earlier winning: Gantry\'s fixed interview rules, the pinned grilling and domain-modeling skills, the Definition\'s Interview instructions (definition, then stage, then module; they only add), the stage purpose and gate, each Field in scope with its guidance, word budget and options, the saved content of every module, the preferred terms, the Source documents (in whole, or a catalogue you open with read_source_document) and the decisions log so far. "parts" lists them; "fields" indexes the Fields in scope. ' +
      '4. "recap" says whether the stage is being resumed ("resuming", a one-line "line"), the open questions, every session on the stage and its state ("sessions", each with "recordedBy": "outside agent" when an agent ran it), a paused session to take over ("adoptable"), sessions still going ("others") and earlier stages\' decisions. ' +
      '5. "instructions" says what is different for an agent (question cards are web-only; ask in your own chat), and "heldModules" names the modules a drafted-ahead stage may not write yet. "stageVersion" is what you save against. ' +
      '6. Read-only: nothing is saved or started. To begin a session use start_interview_session.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to brief instead of the instance\'s current stage.'),
      artefactId: z.string().optional().describe('The artefact aimed for; without it the brief lists the candidates.'),
      who: z.string().optional().describe('The architect being interviewed, so a session they paused is offered to take over.'),
    },
    handler: getInterviewBrief,
  },
  {
    name: 'start_interview_session',
    description:
      '1. Starts an AI interview session for an outside agent: a "run until stage X" session in which you interview the architect in your own chat to draft the instance\'s content stage by stage. Returns the "session" (an id and the run target), the brief and recap (as get_interview_brief), "stageVersion" and "notes". ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". "runUntil" is the stage id the run is to reach (default: the stage being interviewed, a run of one stage). "stage" starts at a stage other than the current one (drafting ahead, on a workspace with Pull Requests). "model" is the model you are, as you report it; "who" the architect you are interviewing. ' +
      '3. Nothing is written by this call: a session is started and recorded only by what you save. Pass the returned "session" to update_instance_modules (at the stage-summary confirm), pause_interview_session, advance_stage and request_approval. ' +
      '4. In a session Gantry holds you to the in-app AI\'s rules: you never pass a gate (it refuses advance_stage until the architect confirmed and you saved with state "saved", and always on a workspace whose stages move on by Pull Request), you request approvals strictly in stage order, you do not write a module an earlier stage with an open Pull Request also mounts, and every save needs the stageVersion. Each refusal carries the reason. ' +
      '5. Content you write stays draft; only a person marks a module agreed.',
    inputSchema: {
      ...slugRefShape,
      runUntil: z.string().optional().describe('The stage id the run is to reach. Defaults to the stage being interviewed.'),
      stage: z.string().optional().describe('A stage id to start at instead of the instance\'s current stage.'),
      artefactId: z.string().optional().describe('The artefact aimed for.'),
      model: z.string().optional().describe('The model you are, as you report it (recorded in the session status; tokens are "not reported").'),
      who: z.string().optional().describe('The architect you are interviewing.'),
    },
    handler: startInterviewSession,
  },
  {
    name: 'pause_interview_session',
    description:
      '1. Pauses an interview session: saves the entries you hold, the session status (state "paused") and, if you pass them, the drafts so far, in one commit, so the session can be resumed by you (resume_interview_session) or by the architect in the browser from the last commit. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". "session" is the session you are in (required). "entries" are decisions-log entries to record (see update_instance_modules). ' +
      '3. With no "modules" it saves the log alone on the stage (no content changes, so the stage version is not needed). With "modules" it is a stage save and "stageVersion" is required, as for update_instance_modules. ' +
      '4. Do this when the architect asks to pause. A pause is the only save besides the stage-summary confirm: nothing is committed per answer. ' +
      '5. This is a real write on a workspace with Pull Requests (one commit on the stage\'s branch) — treat it as final once called.',
    inputSchema: {
      ...slugRefShape,
      session: sessionShape.describe('The session you are in.'),
      stage: z.string().optional().describe('The stage id the session is on; defaults to the instance\'s current stage.'),
      stageVersion: z.string().optional().describe('The "stageVersion" you read; required when you pass "modules".'),
      modules: z.record(z.string(), z.any()).optional().describe('Drafts held so far to save with the pause, keyed by moduleId as for update_instance_modules.'),
      entries: z.array(z.record(z.string(), z.any())).optional().describe('Decisions-log entries to record with the pause.'),
    },
    handler: pauseInterviewSession,
  },
  {
    name: 'resume_interview_session',
    description:
      '1. Resumes an interview session from the last commit, whichever side paused it (you, or the architect in the browser). Runs Check status once first on a workspace whose stage has a Pull Request (what the Provider reports wins over the log), then returns the brief and a recap. The committed decisions log wins over anything you remember or hold: you do not have the earlier conversation. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". "who" is the architect (a session they paused by name is taken over); "session" names a specific session id to take over; with neither, the most recent paused session on the stage is taken over; with none to take over a new session starts. "runUntil" overrides the run target the paused session had. ' +
      '3. The response carries the "session" to pass on, "adopted" (true when it carries on an earlier session, whose status line and models are kept), "checkStatus" (what Check status found, including "merged" when the earlier stage was approved and the instance moved on: you then carry on with the new current stage), "stageVersion", the brief and "recap". Open with the recap in one short line, then ask the next round. ' +
      '4. Nothing is written by this call.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to resume at instead of the instance\'s current stage.'),
      runUntil: z.string().optional().describe('The stage id the run is to reach, instead of the paused session\'s target.'),
      session: z.string().optional().describe('A session id to take over.'),
      who: z.string().optional().describe('The architect; a session they paused is taken over.'),
      model: z.string().optional().describe('The model you are, as you report it.'),
      artefactId: z.string().optional().describe('The artefact aimed for.'),
    },
    handler: resumeInterviewSession,
  },
  {
    name: 'get_review_response_list',
    description:
      '1. Fetches the Review response list for an instance: a Word table, built on demand from every stage\'s committed decisions log, with each answered review comment, who made it, what was decided and why, grouped by Reviewed copy. Gantry never writes it into the Reviewed copy or sends it to the commenters; the architect does that. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. A comment is answered by a "review-answered" entry in the decisions log (update_instance_modules with entries; read the threads with read_reviewed_copy). With none answered the response says so ("rows": 0). ' +
      '4. Returns "rows", "copies", "filename" and the Word document as "docxBase64". Nothing is stored. Render the affected documents again so the commenters see the changes (a save never renders).',
    inputSchema: { ...slugRefShape },
    handler: getReviewResponseList,
  },
  {
    name: 'record_review_answers',
    description:
      '1. Raises each Reviewed copy\'s "comments answered" count once you have answered its comment threads and saved the matching "review-answered" entries, so the web app shows how far the round is. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "answered" is required: { <reviewId>: <how many comments of that copy are answered> }. ' +
      '3. Call it once, after update_instance_modules saved the entries: on a workspace with Pull Requests it is one commit on the current stage\'s branch. Returns the manifest entries. ' +
      '4. This is a real write — treat it as final once called.',
    inputSchema: {
      ...slugRefShape,
      answered: z.record(z.string(), z.number().int().min(0)).describe('A map of Reviewed copy id to the number of its comments answered.'),
    },
    handler: recordReviewAnswers,
  },
]
