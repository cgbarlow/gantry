import { loadDefinition } from './definition.js'
import {
  readInstance,
  recordInstancePullRequest,
  recordInstancePullRequestStatus,
  recordInstanceApprovalState,
  azureDevOpsOutPath,
} from './instance.js'
import { checkGate, formatGateOutstanding, resolveCheckStage } from './check.js'
import { findStageBranch } from './stageBranch.js'
import { createAzureDevOpsPullRequestsClient, AzureDevOpsAuthenticationError } from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'
import { listWorkspaces } from './workspaceRegistry.js'
import { summarizePullRequest } from './stageStatus.js'
import { artefactFileUrl } from './azureDevOpsFileUrl.js'

async function verifyRenderedArtefacts(definition, stage, slug, azureDevOps, checkResult) {
  const completeArtefactIds = new Set(
    checkResult.artefacts.filter((artefact) => artefact.complete).map((artefact) => artefact.id)
  )
  const artefacts = definition.artefacts.filter(
    (artefact) => artefact.gate === stage.gate && completeArtefactIds.has(artefact.id)
  )
  const client = createAzureDevOpsClient(azureDevOps)
  const results = await Promise.all(
    artefacts.map(async (artefact) => {
      const path = azureDevOpsOutPath(slug, artefact.id)
      if (await client.fileExists(path, azureDevOps.branch)) return null
      return { artefact, path }
    })
  )
  const missing = results.filter(Boolean)

  if (missing.length > 0) {
    const details = missing.map(({ artefact, path }) => `"${artefact.title}" (expected ${path})`).join(', ')
    const missingSummary = missing.length === 1 ? `${details} is` : 'are'
    throw new Error(
      `Cannot request approval: required rendered artefact${missing.length === 1 ? '' : 's'} ` +
        `${missingSummary} missing from Azure DevOps branch "${azureDevOps.branch}"` +
        `${missing.length === 1 ? '' : `: ${details}`}`
    )
  }

  return artefacts.map((artefact) => {
    const path = azureDevOpsOutPath(slug, artefact.id)
    return { artefact, path, url: artefactFileUrl(azureDevOps, path, azureDevOps.branch) }
  })
}

/**
 * The Assignee's "Request approval" action for a Workspace-backed instance (#124, ADR-0014, under #106's stage-advancement-via-Pull-Request spec) — the moment that stage's own real approval gate (a Pull Request from `stageId`'s branch, #122's `lib/stageBranch.js`, into `main`) actually opens. Everything that happens *before* this — committing module edits, rendering artefacts to the branch (#123) — is unrestricted throughout the stage; only *opening the Pull Request* is gated, and only on that stage's gate having genuinely passed, re-checked here (via `checkGate`) rather than trusted from an earlier client-side check — the same defense-in-depth every other gated write in this codebase applies (`advanceStage`, `syncGatePassToWorkItem`).
 *
 * Resolves the stage to request approval for the same way `checkGate`/`GET /api/instance/check` do — `options.gate` if given (any stage whose `gate` matches), falling back to the instance's own current stage — so a caller can request approval for a specific gate without first having to know which stage that is.
 *
 * Throws (opening nothing) if:
 * - the gate hasn't passed yet (`checkGate`'s own outstanding-modules message);
 * - the stage has no branch yet at all (`lib/stageBranch.js`'s `findStageBranch` — read-only, never creates one: a stage whose gate has passed but which never actually had a save land on its own branch has nothing for a Pull Request to be opened from, though in practice every real gate-passing save already created it via #123's render-to-branch or any module save, #122);
 * - a rendered artefact for whichever gate-matching artefact(s) actually satisfied the gate (per `checkGate`'s own per-artefact `complete` flags, ADR-0019) is missing from that branch — checked before any Pull Request is opened, with every missing artefact named in the error;
 * - this stage already has a Pull Request recorded (`instance.pullRequests[stageId]`, written by this same function the first time it succeeds) — requesting approval a second time for a stage already mid-review is a caller error, not a fresh action, mirroring `linkInstanceToWorkItem`'s own "already linked" guard;
 * - the effective required reviewer cannot be resolved against Azure DevOps (blank, or the person left the org) — blocked with an actionable error naming which setting to fix (#145).
 *
 * The opened Pull Request always targets `main`, regardless of whether `stageId`'s branch was itself stacked on an immediately preceding, still-open stage branch (ADR-0014, `resolveStageBranch`) rather than forked fresh from `main` — a stacked source shows its predecessor's own not-yet-merged commits in this PR's diff too until that earlier stage's own PR completes, which is an accepted, known consequence of the stacking model (ADR-0014's own "work continues in sequence" rationale), not something this action attempts to hide by re-targeting an intermediate branch.
 *
 * Workspace-backed instances only — `options.azureDevOps` (`{ organization, project, repository, pat, baseUrl? }`) is required; there is no local-instance equivalent (a local instance's own stage advancement, ADR-0012, is the unrelated self-serve action in `lib/stageAdvancement.js`).
 */
export async function requestStageApproval(slug, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('requestStageApproval is for Workspace-backed instances only — pass options.azureDevOps')
  }

  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
  if (!branch) {
    throw new Error(
      `Instance "${slug}" has no branch for stage "${stage.id}" yet — nothing to open a Pull Request from`
    )
  }
  const azureDevOps = { ...azureDevOpsBase, branch }

  const checkResult = await checkGate(slug, { azureDevOps, definitionsDir, gate: options.gate })
  if (!checkResult.pass) {
    throw new Error(
      `Gate "${checkResult.gate}" (stage "${checkResult.stage.id}") has not passed for instance "${slug}" — ` +
        `outstanding: ${formatGateOutstanding(checkResult)}`
    )
  }

  const instance = await readInstance(slug, { azureDevOps })
  const existingPullRequestId = instance.pullRequests?.[stage.id]
  if (existingPullRequestId) {
    const approvalState = instance.approvalStates?.[stage.id]
    if (approvalState?.state === 'invalidated') {
      const client = createAzureDevOpsPullRequestsClient(azureDevOpsBase)
      const pullRequest = await client.getPullRequest(existingPullRequestId)
      if (instance.pullRequestStatuses?.[stage.id] !== pullRequest.status) {
        await recordInstancePullRequestStatus(slug, stage.id, pullRequest.status, { azureDevOps })
      }
      if (pullRequest.status !== 'active') {
        throw new Error(`Pull Request #${existingPullRequestId} for stage "${stage.id}" is no longer active`)
      }

      const reviewerId = approvalState.reviewerId
      if (!reviewerId) {
        throw new Error(`Cannot request approval again for stage "${stage.id}": the stale approver could not be identified`)
      }

      let resetMethod = 'vote-reset'
      try {
        await client.updateReviewerVote(existingPullRequestId, reviewerId, 0)
      } catch (err) {
        if (!(err instanceof AzureDevOpsAuthenticationError && err.status === 403)) throw err
        resetMethod = 'comment'
        await client.commentOnPullRequest(
          existingPullRequestId,
          `Gantry invalidated the approval for this Pull Request because commit(s) landed after ${approvalState.reviewerDisplayName ?? reviewerId} approved it. Please review the new commits and vote again.`,
        )
      }

      await recordInstanceApprovalState(slug, stage.id, null, { azureDevOps })
      const refreshedPullRequest = await client.getPullRequest(existingPullRequestId)
      if (instance.pullRequestStatuses?.[stage.id] !== refreshedPullRequest.status) {
        await recordInstancePullRequestStatus(slug, stage.id, refreshedPullRequest.status, { azureDevOps })
      }
      const commits = await client.getPullRequestCommits(existingPullRequestId)
      const summary = summarizePullRequest(refreshedPullRequest, commits)
      const webUrl = `${azureDevOpsBase.baseUrl ?? 'https://dev.azure.com'}/${encodeURIComponent(azureDevOpsBase.organization)}/${encodeURIComponent(azureDevOpsBase.project)}/_git/${encodeURIComponent(azureDevOpsBase.repository)}/pullrequest/${existingPullRequestId}`
      return {
        slug,
        stage: { id: stage.id, title: stage.title, gate: stage.gate },
        branch,
        pullRequestId: existingPullRequestId,
        status: refreshedPullRequest.status,
        webUrl,
        pullRequest: summary,
        reapproval: { method: resetMethod, reviewer: approvalState.reviewerDisplayName ?? reviewerId },
      }
    }
    throw new Error(
      `Instance "${slug}" already has a Pull Request (#${existingPullRequestId}) open requesting approval for ` +
        `stage "${stage.id}"`
    )
  }

  const renderedArtefacts = await verifyRenderedArtefacts(definition, stage, slug, azureDevOps, checkResult)

  // --- Required reviewer resolution (#145 Part 2) ---
  // Effective reviewer = per-instance override if set, else the workspace's Owner.
  // When a reviewer is configured and can be resolved, it is attached as a required
  // reviewer on the Pull Request — merging it then requires that person's approval.
  // When *nothing* is configured (no per-instance override, no workspace Owner),
  // the PR opens without attaching a required reviewer (backwards compatible with
  // pre-#145 behaviour). Only when a reviewer IS configured but cannot be resolved
  // (e.g. person left the org) is approval blocked with an actionable error.
  const requiredReviewerOverride = instance.requiredReviewer ?? ''
  let effectiveReviewerValue = requiredReviewerOverride
  let reviewerSource = 'instance override'

  if (!effectiveReviewerValue) {
    // Fall back to the workspace Owner
    const workspaces = listWorkspaces()
    const workspace = workspaces.find(
      (ws) =>
        ws.organization === azureDevOpsBase.organization &&
        ws.project === azureDevOpsBase.project &&
        ws.repository === azureDevOpsBase.repository
    )
    effectiveReviewerValue = workspace?.owner ?? ''
    reviewerSource = 'workspace Owner'
  }

  // Resolve the reviewer only if one is actually configured — unconfigured
  // means "no required reviewer" (backwards-compatible), not an error.
  let resolvedReviewer = null
  if (effectiveReviewerValue && effectiveReviewerValue.trim()) {
    const identityClient = createAzureDevOpsIdentityClient({
      organization: azureDevOpsBase.organization,
      project: azureDevOpsBase.project,
      baseUrl: azureDevOpsBase.baseUrl,
      pat: azureDevOpsBase.pat,
    })

    try {
      resolvedReviewer = await identityClient.resolveIdentity(effectiveReviewerValue)
    } catch (err) {
      if (err instanceof AzureDevOpsAuthenticationError) err.operation = 'resolving the required reviewer for Request Approval'
      throw err
    }
    if (!resolvedReviewer) {
      throw new Error(
        `Cannot request approval: the ${reviewerSource} ("${effectiveReviewerValue}") could not be resolved ` +
          `to a known Azure DevOps identity. If the person has left the org, update the ${reviewerSource} ` +
          `${reviewerSource === 'instance override' ? 'in Instance Settings' : 'in Workspace Settings'}.`
      )
    }
  }

  // --- Open the Pull Request ---
  const client = createAzureDevOpsPullRequestsClient(azureDevOpsBase)
  const pullRequest = await client.createPullRequest({
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Request approval: ${stage.title} — ${slug}`,
    description:
      `Requests approval for the "${stage.title}" stage of gantry instance "${slug}" (gate "${stage.gate}"). ` +
      'Merging this Pull Request completes the stage.\n\n' +
      'Rendered artefacts for review:\n' +
      renderedArtefacts.map(({ artefact, url }) => `- [${artefact.title}](${url})`).join('\n'),
  })

  // Attach the resolved reviewer as a required reviewer on the PR, if one was
  // resolved. When no reviewer is configured, the PR opens without one.
  if (resolvedReviewer) {
    await client.addReviewers(pullRequest.pullRequestId, [
      { id: resolvedReviewer.id, required: true },
    ])
  }

  await recordInstancePullRequest(slug, stage.id, pullRequest.pullRequestId, {
    azureDevOps,
    pullRequestStatus: pullRequest.status,
  })
  const commits = await client.getPullRequestCommits(pullRequest.pullRequestId)
  const pullRequestSummary = summarizePullRequest(await client.getPullRequest(pullRequest.pullRequestId), commits)

  // A user-facing web link (distinct from the REST API `url` Azure DevOps's
  // own pull request payload carries) — built the same way Azure DevOps's
  // own UI links a pull request, so a caller (the web form) can offer the
  // architect a direct "open in Azure DevOps" link without constructing it
  // itself from the separate organization/project/repository fields.
  const webUrl = `${azureDevOpsBase.baseUrl ?? 'https://dev.azure.com'}/${encodeURIComponent(azureDevOpsBase.organization)}/${encodeURIComponent(azureDevOpsBase.project)}/_git/${encodeURIComponent(azureDevOpsBase.repository)}/pullrequest/${pullRequest.pullRequestId}`

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    branch,
    pullRequestId: pullRequest.pullRequestId,
    status: pullRequest.status,
    webUrl,
    pullRequest: pullRequestSummary,
    ...(resolvedReviewer ? { reviewer: { displayName: resolvedReviewer.displayName, uniqueName: resolvedReviewer.uniqueName } } : {}),
  }
}
