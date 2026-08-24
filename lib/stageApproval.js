import { loadDefinition } from './definition.js'
import { readInstance, recordInstancePullRequest } from './instance.js'
import { checkGate, resolveCheckStage } from './check.js'
import { findStageBranch } from './stageBranch.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'

/**
 * The Assignee's "Request approval" action for a Workspace-backed instance (#124, ADR-0014, under #106's stage-advancement-via-Pull-Request spec) — the moment that stage's own real approval gate (a Pull Request from `stageId`'s branch, #122's `lib/stageBranch.js`, into `main`) actually opens. Everything that happens *before* this — committing module edits, rendering artefacts to the branch (#123) — is unrestricted throughout the stage; only *opening the Pull Request* is gated, and only on that stage's gate having genuinely passed, re-checked here (via `checkGate`) rather than trusted from an earlier client-side check — the same defense-in-depth every other gated write in this codebase applies (`advanceStage`, `syncGatePassToWorkItem`).
 *
 * Resolves the stage to request approval for the same way `checkGate`/`GET /api/instance/check` do — `options.gate` if given (any stage whose `gate` matches), falling back to the instance's own current stage — so a caller can request approval for a specific gate without first having to know which stage that is.
 *
 * Throws (opening nothing) if:
 * - the gate hasn't passed yet (`checkGate`'s own outstanding-modules message);
 * - the stage has no branch yet at all (`lib/stageBranch.js`'s `findStageBranch` — read-only, never creates one: a stage whose gate has passed but which never actually had a save land on its own branch has nothing for a Pull Request to be opened from, though in practice every real gate-passing save already created it via #123's render-to-branch or any module save, #122);
 * - this stage already has a Pull Request recorded (`instance.pullRequests[stageId]`, written by this same function the first time it succeeds) — requesting approval a second time for a stage already mid-review is a caller error, not a fresh action, mirroring `linkInstanceToWorkItem`'s own "already linked" guard.
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
    const outstanding = checkResult.modules.filter((m) => !m.complete).map((m) => m.title)
    throw new Error(
      `Gate "${checkResult.gate}" (stage "${checkResult.stage.id}") has not passed for instance "${slug}" — ` +
        `outstanding: ${outstanding.join(', ') || 'see modules'}`
    )
  }

  const instance = await readInstance(slug, { azureDevOps })
  const existingPullRequestId = instance.pullRequests?.[stage.id]
  if (existingPullRequestId) {
    throw new Error(
      `Instance "${slug}" already has a Pull Request (#${existingPullRequestId}) open requesting approval for ` +
        `stage "${stage.id}"`
    )
  }

  const client = createAzureDevOpsPullRequestsClient(azureDevOpsBase)
  const pullRequest = await client.createPullRequest({
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Request approval: ${stage.title} — ${slug}`,
    description:
      `Requests approval for the "${stage.title}" stage of gantry instance "${slug}" (gate "${stage.gate}"). ` +
      'Merging this Pull Request completes the stage.',
  })

  await recordInstancePullRequest(slug, stage.id, pullRequest.pullRequestId, { azureDevOps })

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
  }
}
