import { loadDefinition } from './definition.js'
import { readInstance, instanceDefinitionVersion } from './instance.js'
import { remoteProvider } from './changedSinceApproval.js'
import { checkStageApprovalStatus } from './stageStatus.js'
import { reopenStage } from './stageReopen.js'
import { AuthenticationError, NotFoundError } from './providerErrors.js'

// A merged-but-unrecorded approval (#144, docs/adr/0014): the current stage's approval Pull Request has been merged on
// the Provider — a reviewer or the Owner completed it there — but nobody has pressed Check status, so Gantry has not
// recorded the approval and the instance has not moved on. Re-open (docs/adr/0026) only exists for completed stages,
// so until now the only way to "re-open for late comments" was to press Check status (which advances the instance),
// then walk back to the earlier stage's tab.
//
// The decision (product owner, 2026-11-02): **prompt only**. Opening the page never records anything (ADR-0014:
// approval is recorded only by an explicit action, never on page load or by polling). Detecting the situation is a
// read of the Pull Request's status, which the page load already makes; the two writes below happen only when the
// person presses one of the two buttons.

/** The remote providers whose Pull Requests this knows how to read: the same set `remoteProvider` serves. */
const REMOTE_PROVIDER_KEYS = ['azureDevOps', 'github', 'gitlab']

/** `'azureDevOps'`, `'github'` or `'gitlab'` — whichever of them `options` carries a credentialed location for. */
export function remoteProviderKeyOf(options) {
  return REMOTE_PROVIDER_KEYS.find((key) => options?.[key])
}

function stageInProgressMessage(laterId, stageId) {
  // The wording ADR-0026's guard already uses, so the disabled button and a refused re-open say the same thing.
  return `Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`
}

/**
 * Why re-opening `stage` can't be offered right now, or `null` when it can. Mirrors the refusals `reopenStage`
 * (lib/stageReopen.js, ADR-0026) would give *after* the approval had been recorded, so a "record and re-open" that is
 * going to be refused is refused up front instead of leaving the approval recorded and the stage not re-opened:
 *
 * - the final stage has nothing after it to move on from, so there is nothing to re-open — recording the approval is
 *   all there is to do, and a later edit starts a fresh stage branch from `main` as for any stage;
 * - a later stage that already has a branch (including one drafted ahead, ADR-0063) is in progress;
 * - the stage's own branch still exists on the Provider (it is only recreated by a re-open, so it must be gone).
 */
async function reopenBlockReason({ provider, base, slug, definition, stage, branch }) {
  const index = definition.stages.findIndex((s) => s.id === stage.id)
  if (index === definition.stages.length - 1) {
    return `"${stage.title ?? stage.id}" is the final stage, so there is nothing to move on from and nothing to re-open. Record the approval; a later edit starts a fresh branch from main.`
  }
  for (let i = index + 1; i < definition.stages.length; i++) {
    const laterId = definition.stages[i].id
    // eslint-disable-next-line no-await-in-loop
    if (await provider.findStageBranch(base, slug, laterId)) return stageInProgressMessage(laterId, stage.id)
  }
  if (branch) return `The branch for "${stage.title ?? stage.id}" (${branch}) is still on the Provider — delete it there (the merge is done), then come back to re-open.`
  return null
}

// The recorded status of the stage's Pull Request on either copy of instance.yaml: a stage whose status is already
// recorded as completed (Check status ran, or the stage was re-opened and its old Pull Request is history) has
// nothing left to record.
function recordedCompleted(stageId, ...instances) {
  return instances.some((instance) => instance?.pullRequestStatuses?.[stageId] === 'completed')
}

/**
 * The read behind the stage page's notice. Returns `null` unless the viewed stage is the instance's current stage, it
 * has an approval Pull Request, the Provider says that Pull Request is merged, and Gantry hasn't recorded it.
 * Otherwise `{ stageId, title, pullRequestId, next, reopen: { allowed, reason } }` — `next` being the stage recording
 * moves on to (`null` for the final stage).
 *
 * Read-only on every provider. `bootstrapInstance` is the copy on `main` (which says which stage is current),
 * `instance` the copy the page already read (the stage branch's if there is one), `branch` that stage branch or
 * `null`/`undefined`. `pullRequestStatus` saves a second read when the caller already fetched the Pull Request.
 */
export async function findMergedUnrecordedApproval({ providerKey, base, slug, definition, stage, bootstrapInstance, instance, branch, pullRequestStatus }) {
  const provider = remoteProvider(providerKey)
  if (!provider) return null
  if (stage.id !== bootstrapInstance.stage) return null
  const pullRequestId = instance.pullRequests?.[stage.id] ?? bootstrapInstance.pullRequests?.[stage.id]
  if (!pullRequestId) return null
  if (recordedCompleted(stage.id, bootstrapInstance, instance)) return null

  let status = pullRequestStatus
  if (status === undefined) {
    try {
      status = (await provider.pullRequests(base).getPullRequest(pullRequestId)).status
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }
  if (status !== 'completed') return null

  const index = definition.stages.findIndex((s) => s.id === stage.id)
  const next = definition.stages[index + 1] ?? null
  const reason = await reopenBlockReason({ provider, base, slug, definition, stage, branch })
  return {
    stageId: stage.id,
    title: stage.title,
    pullRequestId,
    next: next ? { id: next.id, title: next.title } : null,
    reopen: { allowed: reason === null, ...(reason ? { reason } : {}) },
  }
}

/**
 * `findMergedUnrecordedApproval` for the instance read, which must not fail over this advisory notice: a credential
 * problem still propagates (the usual "authentication required" handling applies), any other failure reading the
 * Provider yields no notice.
 */
export async function findMergedUnrecordedApprovalSafely(args) {
  try {
    return await findMergedUnrecordedApproval(args)
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    console.error(`lib/mergedApproval.js: could not check "${args.slug}" for a merged, unrecorded approval — ${err.message}`)
    return null
  }
}

function refusal(message, status = 409) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * The write behind the notice's two buttons (#144). Records the approval of the current stage's merged Pull Request —
 * exactly what Check status does for a merged Pull Request (clear any re-open marker, move the instance on, push the
 * linked work item), by running it — and, with `reopen: true`, then re-opens that stage for changes
 * (lib/stageReopen.js, ADR-0026: a fresh branch from `main`, the approval history kept).
 *
 * Refuses (409, writing nothing) when the Pull Request isn't merged on the Provider, so this can't be used to skip a
 * review; and, for `reopen`, when ADR-0026's guard would refuse the re-open afterwards, so the approval is never
 * recorded for a re-open that then can't happen. `options` is what Check status takes: `{ azureDevOps | github |
 * gitlab: { ...location, pat }, definitionsDir }`.
 *
 * Returns Check status's answer, plus `reopened` (Re-open's answer, or `null` when only recording).
 */
export async function recordMergedApproval(slug, options = {}) {
  const { reopen = false, ...providerOptions } = options
  const providerKey = remoteProviderKeyOf(providerOptions)
  const provider = remoteProvider(providerKey)
  if (!provider) throw new Error('recordMergedApproval is for Workspace-backed instances only — pass options.azureDevOps, options.github or options.gitlab')
  const base = providerOptions[providerKey]

  const definitionsDir = providerOptions.definitionsDir ?? 'definitions'
  const bootstrapInstance = await readInstance(slug, { [providerKey]: base })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
  if (!stage) throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)

  const branch = await provider.findStageBranch(base, slug, stage.id)
  const instance = branch ? await readInstance(slug, { [providerKey]: { ...base, branch } }) : bootstrapInstance
  const pullRequestId = instance.pullRequests?.[stage.id] ?? bootstrapInstance.pullRequests?.[stage.id]
  if (!pullRequestId) {
    throw refusal(`Instance "${slug}" has no approval Pull Request for stage "${stage.id}" — request approval first; there is nothing to record.`, 400)
  }
  const pullRequest = await provider.pullRequests(base).getPullRequest(pullRequestId)
  if (pullRequest.status !== 'completed') {
    throw refusal(`Pull Request #${pullRequestId} for stage "${stage.id}" has not been merged on the Provider, so there is no approval to record. Use Check status to see where the review stands.`)
  }

  if (reopen) {
    const reason = await reopenBlockReason({ provider, base, slug, definition, stage, branch })
    if (reason) throw refusal(reason)
  }

  const recorded = await checkStageApprovalStatus(slug, providerOptions)
  if (!recorded.merged) {
    throw refusal(`Pull Request #${pullRequestId} for stage "${stage.id}" is not merged, so no approval was recorded.`)
  }
  if (!reopen) return { ...recorded, reopened: null }

  try {
    const reopened = await reopenStage(slug, stage.id, providerOptions)
    return { ...recorded, reopened }
  } catch (err) {
    // The approval is recorded and the instance has moved on; say so, so the person re-opens from the completed stage.
    if (err instanceof AuthenticationError) throw err
    throw refusal(`The approval was recorded and the instance moved on, but re-opening "${stage.title ?? stage.id}" failed: ${err.message} Re-open it from its tab.`, err.status === 409 ? 409 : 400)
  }
}
