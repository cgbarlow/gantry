import { z } from 'zod'
import { resolveInstanceWorkspace } from '../gantryClient.js'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

// Shared by every tool below: resolves the instance's workspace id (for credential attachment) from
// whichever of slug/scope/ref the caller supplied. Returns `{ workspaceId, scope }` on success, or a
// tool result (already shaped for return) on failure — check `.errorResult` to tell the two apart.
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

// 1. check_gate — GET /api/instance/check. Read-only completeness check; requires a credential for a
// Provider-backed instance (it reads that instance's own module content from the Provider to evaluate
// the gate), but none for a local/server-directory instance — verified against lib/server.js directly,
// not assumed.
async function checkGate(args, { gantryClient }) {
  const { slug, scope, ref, gate } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/check',
    query: { slug, scope: scope ?? resolved.scope, ref, gate },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 2. advance_stage — POST /api/instance/advance-stage. Local-instance self-serve only; gantry serve
// itself re-checks the gate server-side and rejects outright (400) if the instance is Workspace-backed
// (it must go through request_approval/check_status instead) or if the current stage's gate hasn't
// passed — never trust a prior check_gate call, always let this 400 speak for itself.
async function advanceStage(args, { gantryClient }) {
  const { slug, scope, ref } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/advance-stage',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 3. request_approval — POST /api/instance/request-approval. Workspace-backed only: opens the actual
// stage Pull Request, re-checking the gate server-side first. Rejected outright (400) for a local
// instance — it has no Pull Request to open; use advance_stage instead.
async function requestApproval(args, { gantryClient }) {
  const { slug, scope, ref, gate } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/request-approval',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { gate },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 4. check_status — POST /api/instance/check-status. Workspace-backed only: reads the open stage Pull
// Request's reviewer votes and, on detecting the Owner's approval, merges it and advances the stage
// pointer itself. Rejected outright (400) for a local instance, for the same reason as request_approval.
async function checkStatus(args, { gantryClient }) {
  const { slug, scope, ref, gate } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/check-status',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { gate },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 5. request_review — POST /api/instance/request-review. Informal, non-gating reviewer request —
// creates its own tracked Task/issue, independent of the approval pair above. Workspace-backed only.
async function requestReview(args, { gantryClient }) {
  const { slug, scope, ref, stage, reviewer } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/request-review',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { stage, reviewer },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 6. check_review_status — POST /api/instance/review-status. Reads back the tracked review's current
// state; the result is persisted server-side so it stays useful without polling. Pass reviewId from a
// prior request_review response to check that specific review.
async function checkReviewStatus(args, { gantryClient }) {
  const { slug, scope, ref, stage, reviewId } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/review-status',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { stage, reviewId },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 7. reopen_stage — POST /api/instance/stage/reopen. Re-opens a signed-off stage for late feedback
// (docs/adr/0026). Workspace-backed only; "stage" is required — gantry serve 400s without it.
async function reopenStage(args, { gantryClient }) {
  const { slug, scope, ref, stage } = args
  if (!stage) {
    return errorResult('Provide "stage" — the stage id to re-open.')
  }
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/stage/reopen',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { stage },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 8. sync_stage_branch — POST /api/instance/stage-branch/sync. Merges `main` into a stage's own branch
// (WI256) to pull in later-merged upstream changes before that stage's own Pull Request closes.
// Workspace-backed (Azure DevOps) only; unlike the other tools here, gantry serve resolves the target
// stage from the query string only ("stage"/"stageNumber"), never from a body.
async function syncStageBranch(args, { gantryClient }) {
  const { slug, scope, ref, stage, stageNumber } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/stage-branch/sync',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref, stage, stageNumber },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

export const tools = [
  {
    name: 'check_gate',
    description:
      '1. Runs a read-only completeness check ("Check") against an instance\'s current (or a named) stage-gate — the same check gantry serve re-runs server-side before any gated write below. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "gate" (a gate id) to check a specific gate instead of the stage\'s own default. ' +
      '4. A local/server-directory instance needs no credential; a Provider-backed instance reads its module content from that Provider and so needs the usual PAT — a missing/rejected one is reported as "missing_workspace_pat"/"authentication_required", never guessed. ' +
      '5. Use the response\'s "complete" field before calling advance_stage or request_approval — both re-check server-side and reject if the gate hasn\'t passed, but this lets you explain why up front. ' +
      '6. The gate passes when any one artefact that counts toward it is complete. Each entry in "artefacts" reports its own "complete" and "outstanding", and "satisfiesGate": false marks one whose definition sets "satisfies-gate: false" — typically a document for someone outside the process, such as a candidate. Completing that artefact alone never passes the gate, though it is still rendered and linked in the approval request once complete; to pass, complete an artefact with "satisfiesGate": true.',
    inputSchema: {
      ...slugRefShape,
      gate: z.string().optional().describe('A specific gate id to check, instead of the stage\'s own default.'),
    },
    handler: checkGate,
  },
  {
    name: 'advance_stage',
    description:
      '1. Self-serve "Advance to next stage" for a *local* instance only — moves its persisted stage pointer forward by one, gated on the current stage\'s gate having genuinely passed (re-checked server-side, never trusted from a prior check_gate call). ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Rejected with a 400 for a Workspace-backed instance — it advances only once its stage\'s own Pull Request is merged, via request_approval -> check_status instead. ' +
      '4. No credential is required or consulted; this only ever writes to local instance data.',
    inputSchema: { ...slugRefShape },
    handler: advanceStage,
  },
  {
    name: 'request_approval',
    description:
      '1. The Assignee\'s "Request approval" action for a *Workspace-backed* instance — opens the actual approval gate, a Pull Request from the current stage\'s own branch into main, re-checking the gate server-side first. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "gate" (a gate id) to target a specific gate instead of the stage\'s own default. ' +
      '4. Rejected with a 400 for a local instance — it has no Pull Request to open; call advance_stage instead. ' +
      '5. Requires a PAT for the instance\'s workspace; a missing/rejected one is reported as "missing_workspace_pat"/"authentication_required". ' +
      '6. Follow up with check_status once a reviewer has had a chance to approve.',
    inputSchema: {
      ...slugRefShape,
      gate: z.string().optional().describe('A specific gate id to request approval for, instead of the stage\'s own default.'),
    },
    handler: requestApproval,
  },
  {
    name: 'check_status',
    description:
      '1. The explicitly-triggered "Check status" action for a *Workspace-backed* instance — reads the current stage\'s open Pull Request\'s reviewer votes; on detecting the Owner\'s approval it completes (merges) the Pull Request itself, advances the stage pointer, and pushes the linked work item\'s state. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "gate" (a gate id) if request_approval targeted a specific gate. ' +
      '4. Rejected with a 400 for a local instance — it has no Pull Request to check. ' +
      '5. Requires a PAT for the instance\'s workspace, for the same reason request_approval does. ' +
      '6. An explicit rejection/changes-requested vote is reported distinctly from a merely-still-pending review — read the response\'s own fields rather than inferring from success/failure alone.',
    inputSchema: {
      ...slugRefShape,
      gate: z.string().optional().describe('A specific gate id to check status for, instead of the stage\'s own default.'),
    },
    handler: checkStatus,
  },
  {
    name: 'request_review',
    description:
      '1. Requests an informal, non-gating review of a *Workspace-backed* instance\'s stage — creates its own tracked Task (Azure DevOps) or labelled/assigned issue (GitHub), independent of the request_approval/check_status pair. Never opens or changes a Pull Request. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "stage" (a stage id) to target a stage other than the one currently being viewed; "reviewer" (optional) names who to request review from. ' +
      '4. Rejected with a 400 for a local instance — review requests are Workspace-backed only. ' +
      '5. Requires a PAT for the instance\'s workspace. ' +
      '6. Use the response\'s review id with check_review_status to poll it later.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to request review on, instead of the stage currently being viewed.'),
      reviewer: z.string().optional().describe('Who to request review from.'),
    },
    handler: requestReview,
  },
  {
    name: 'check_review_status',
    description:
      '1. Reads back a *Workspace-backed* instance\'s tracked review request\'s current state (Azure DevOps Task state, or a GitHub review issue\'s current "gantry:review/*" label) — independent of the request_approval/check_status pair. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "reviewId" from a prior request_review response to check that specific review, and/or "stage" to disambiguate. ' +
      '4. The result is persisted server-side, so this stays useful across reloads without needing to poll. ' +
      '5. Rejected with a 400 for a local instance; requires a PAT for the instance\'s workspace.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('The stage id the review belongs to.'),
      reviewId: z.string().optional().describe('The review id from a prior request_review response.'),
    },
    handler: checkReviewStatus,
  },
  {
    name: 'reopen_stage',
    description:
      '1. Re-opens a previously signed-off stage on a *Workspace-backed* instance for late feedback (docs/adr/0026). ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "stage" (a stage id) is required. ' +
      '3. Rejected with a 400 for a local instance — re-opening is Workspace-backed only. ' +
      '4. Requires a PAT for the instance\'s workspace; a missing/rejected one is reported as "missing_workspace_pat"/"authentication_required". ' +
      '5. Can itself fail with a 409 (e.g. the stage\'s branch/Pull Request state doesn\'t allow re-opening right now) — surfaced as an upstream error, not thrown.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().describe('The stage id to re-open.'),
    },
    handler: reopenStage,
  },
  {
    name: 'sync_stage_branch',
    description:
      '1. Merges main into a *Workspace-backed* (Azure DevOps) instance\'s current stage branch (WI256) — pulls in changes merged upstream since the stage branch was created, so the stage\'s own Pull Request stays mergeable. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "stage" (a stage id) or "stageNumber" to target a stage other than the instance\'s current one. ' +
      '4. Rejected with a 400 if the instance is not Workspace-backed, a 404 if that stage has no branch yet (nothing to sync), and a 409 if the stage is already complete or the merge itself conflicts (the conflict response includes the opened Pull Request\'s id/URL to resolve it in) — every one of these comes back as an upstream error, never thrown. ' +
      '5. Requires a PAT for the instance\'s workspace.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to sync, instead of the instance\'s current stage.'),
      stageNumber: z.number().int().positive().optional().describe('A 1-based stage number, as an alternative to "stage".'),
    },
    handler: syncStageBranch,
  },
]
