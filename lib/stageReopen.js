import { loadDefinition } from './definition.js'
import { readInstance, recordInstanceReopened, instanceDefinitionVersion, azureDevOpsInstancePath, githubInstancePath, gitlabInstancePath } from './instance.js'
import { stageBranchName, findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { createGitHubClient } from './githubClient.js'
import { createGitLabClient } from './gitlabClient.js'
import { stringify as stringifyYAML } from 'yaml'

function canonicalizeForSerialization(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSerialization)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeForSerialization(value[key])
    }
    return sorted
  }
  return value
}
function stringifyInstanceYAML(record) {
  return stringifyYAML(canonicalizeForSerialization(record))
}

/**
 * Re-open a signed-off stage for late feedback (WI265, docs/adr/0026).
 *
 * Workspace-backed instances only — `options.azureDevOps` or `options.github` is required. Dispatches
 * to `reopenGitHubStage` below for the latter (#13, ADR-0037/0040: "Re-opening a signed-off stage
 * works on GitHub too") — same restrictions, same shape, a GitHub content-store client instead of an
 * Azure DevOps one.
 *
 * Throws on:
 * - unknown stage
 * - stage is current (not completed)
 * - branch already exists (409)
 * - later stage already in progress (branch exists or >1 stage past) (409)
 */
export async function reopenStage(slug, stageId, options = {}) {
  if (options.github) {
    return reopenGitHubStage(slug, stageId, options)
  }
  if (options.gitlab) {
    return reopenGitLabStage(slug, stageId, options)
  }
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('reopenStage is for Workspace-backed instances only — pass options.azureDevOps or options.github')
  }
  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })

  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const targetIdx = definition.stages.findIndex((s) => s.id === stageId)
  const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
  if (currentIdx === -1 || targetIdx === -1) {
    throw new Error(`Instance "${slug}" stage resolution failed`)
  }
  if (targetIdx >= currentIdx) {
    throw new Error(`Stage "${stageId}" is not completed — only a stage before the current stage "${bootstrapInstance.stage}" can be re-opened`)
  }

  // Guard: later stage already in progress
  // 1) any stage after target already has a branch
  for (let i = targetIdx + 1; i < definition.stages.length; i++) {
    const laterId = definition.stages[i].id
    // eslint-disable-next-line no-await-in-loop
    const branch = await findStageBranch(azureDevOpsBase, slug, laterId)
    if (branch) {
      const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
      err.status = 409
      throw err
    }
  }
  // 2) advanced more than one stage past target
  if (currentIdx - targetIdx > 1) {
    const laterId = definition.stages[targetIdx + 1].id
    const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
    err.status = 409
    throw err
  }

  const branchName = stageBranchName(slug, stageId)
  const client = createAzureDevOpsClient(azureDevOpsBase)
  if (await client.branchExists(branchName)) {
    const err = new Error(`Stage branch "${branchName}" already exists`)
    err.status = 409
    throw err
  }

  const previousStage = bootstrapInstance.stage

  // Record reopened marker + move stage pointer back — written to `main` FIRST,
  // *before* the stage branch is (re)created. Ordering matters: the branch is
  // created `from: 'main'` so it inherits the reopened `instance.yaml`. If the
  // marker were written to main *after* branch creation, `instance.yaml` would
  // diverge on both sides (branch's audit commit vs. main's marker write) from
  // the branch's pre-reopen base — and the eventual stage→main approval PR would
  // hit a 3-way merge conflict on `instance.yaml` even though both sides made
  // the identical change.
  const nextInstance = await recordInstanceReopened(slug, stageId, previousStage, { azureDevOps: azureDevOpsBase })

  // Recreate branch from current main (now carrying the reopened marker)
  await client.createBranch(branchName, { from: 'main' })

  // Audit commit on the stage branch — a commit whose message names the re-open.
  // The branch already reflects the reopened `instance.yaml` (inherited from
  // main above); re-writing the identical bytes just attaches the audit message.
  // A failure here (e.g. a real Azure DevOps push rejecting a no-diff commit)
  // must not roll the re-open back — the work-item history push below is the
  // durable audit record.
  try {
    await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(nextInstance), {
      branch: branchName,
      message: `Re-open stage '${stageId}' of instance '${slug}' (was at '${previousStage}')`,
    })
  } catch (_) {
    // Ignore — re-open already succeeded; audit is best-effort.
  }

  // Work item audit: if linked, push comment/history
  let workItemSync = null
  if (bootstrapInstance.workItem) {
    const workItemId = bootstrapInstance.workItem.stages?.[stageId]
    if (workItemId) {
      try {
        const wiClient = createAzureDevOpsWorkItemsClient({
          organization: bootstrapInstance.workItem.organization,
          project: bootstrapInstance.workItem.project,
          pat: azureDevOpsBase.pat,
          baseUrl: bootstrapInstance.workItem.baseUrl,
        })
        const updated = await wiClient.updateWorkItem(workItemId, {
          'System.History': `Re-opened stage '${stageId}' of instance '${slug}' for late feedback (was at '${previousStage}').`,
        })
        workItemSync = { ok: true, workItemId, workItem: updated }
      } catch (err) {
        workItemSync = { ok: false, workItemId, error: err.message }
      }
    } else {
      // No stage-specific work item, try parent?
      try {
        const wiClient = createAzureDevOpsWorkItemsClient({
          organization: bootstrapInstance.workItem.organization,
          project: bootstrapInstance.workItem.project,
          pat: azureDevOpsBase.pat,
          baseUrl: bootstrapInstance.workItem.baseUrl,
        })
        const updated = await wiClient.updateWorkItem(bootstrapInstance.workItem.parentId, {
          'System.History': `Re-opened stage '${stageId}' of instance '${slug}' for late feedback (was at '${previousStage}').`,
        })
        workItemSync = { ok: true, workItemId: bootstrapInstance.workItem.parentId, workItem: updated }
      } catch (err) {
        workItemSync = { ok: false, error: err.message }
      }
    }
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    branch: branchName,
    previousStage,
    reopened: nextInstance.reopened,
    workItemSync,
  }
}

/**
 * The GitHub twin of `reopenStage` above (#13) — identical restrictions and identical shape, over a
 * GitHub-backed instance's stage branches: unknown stage, stage not yet completed, a later stage
 * already in progress (its own branch exists, or the instance sits more than one stage past `stageId`)
 * and an already-existing target branch are all 409s exactly as the Azure DevOps path reports them.
 *
 * `workItemSync` is always `null` here: `lib/githubWorkItemsClient.js` doesn't yet expose a comment
 * capability for a linked GitHub issue (ADR-0039 lists "comment" as part of the work-items interface,
 * but no ticket has implemented it against GitHub Issues yet) — deliberately left out of this ticket's
 * scope rather than half-implemented as a body-overwrite. The re-open itself (branch pointer, marker,
 * audit commit on the stage branch) is unaffected; only the optional linked-issue audit note is
 * skipped.
 */
async function reopenGitHubStage(slug, stageId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const githubBase = options.github
  const bootstrapInstance = await readInstance(slug, { github: githubBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })

  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const targetIdx = definition.stages.findIndex((s) => s.id === stageId)
  const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
  if (currentIdx === -1 || targetIdx === -1) {
    throw new Error(`Instance "${slug}" stage resolution failed`)
  }
  if (targetIdx >= currentIdx) {
    throw new Error(`Stage "${stageId}" is not completed — only a stage before the current stage "${bootstrapInstance.stage}" can be re-opened`)
  }

  for (let i = targetIdx + 1; i < definition.stages.length; i++) {
    const laterId = definition.stages[i].id
    // eslint-disable-next-line no-await-in-loop
    const branch = await findGitHubStageBranch(githubBase, slug, laterId)
    if (branch) {
      const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
      err.status = 409
      throw err
    }
  }
  if (currentIdx - targetIdx > 1) {
    const laterId = definition.stages[targetIdx + 1].id
    const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
    err.status = 409
    throw err
  }

  const branchName = stageBranchName(slug, stageId)
  const client = createGitHubClient(githubBase)
  if (await client.branchExists(branchName)) {
    const err = new Error(`Stage branch "${branchName}" already exists`)
    err.status = 409
    throw err
  }

  const previousStage = bootstrapInstance.stage

  // Same ordering as the Azure DevOps path above: written to `main` first, so the branch created
  // `from: 'main'` right after already inherits the reopened `instance.yaml`.
  const nextInstance = await recordInstanceReopened(slug, stageId, previousStage, { github: githubBase })

  await client.createBranch(branchName, { from: 'main' })

  try {
    await client.writeFile(githubInstancePath(slug), stringifyInstanceYAML(nextInstance), {
      branch: branchName,
      message: `Re-open stage '${stageId}' of instance '${slug}' (was at '${previousStage}')`,
    })
  } catch (_) {
    // Ignore — re-open already succeeded; audit is best-effort, same as the Azure DevOps path.
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    branch: branchName,
    previousStage,
    reopened: nextInstance.reopened,
    workItemSync: null,
  }
}

/**
 * The GitLab twin of `reopenGitHubStage` above (#33, ADR-0041) — identical restrictions and identical
 * shape, over a GitLab-backed instance's stage branches: unknown stage, stage not yet completed, a
 * later stage already in progress (its own branch exists, or the instance sits more than one stage past
 * `stageId`) and an already-existing target branch are all 409s exactly as the Azure DevOps/GitHub paths
 * report them.
 *
 * `workItemSync` is always `null` here, for the same reason it is on the GitHub path:
 * `lib/gitlabWorkItemsClient.js` doesn't yet expose a comment capability for a linked GitLab issue —
 * left out of this ticket's scope rather than half-implemented as a body-overwrite. The re-open itself
 * (branch pointer, marker, audit commit on the stage branch) is unaffected; only the optional
 * linked-issue audit note is skipped.
 */
async function reopenGitLabStage(slug, stageId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const gitlabBase = options.gitlab
  const bootstrapInstance = await readInstance(slug, { gitlab: gitlabBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })

  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const targetIdx = definition.stages.findIndex((s) => s.id === stageId)
  const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
  if (currentIdx === -1 || targetIdx === -1) {
    throw new Error(`Instance "${slug}" stage resolution failed`)
  }
  if (targetIdx >= currentIdx) {
    throw new Error(`Stage "${stageId}" is not completed — only a stage before the current stage "${bootstrapInstance.stage}" can be re-opened`)
  }

  for (let i = targetIdx + 1; i < definition.stages.length; i++) {
    const laterId = definition.stages[i].id
    // eslint-disable-next-line no-await-in-loop
    const branch = await findGitLabStageBranch(gitlabBase, slug, laterId)
    if (branch) {
      const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
      err.status = 409
      throw err
    }
  }
  if (currentIdx - targetIdx > 1) {
    const laterId = definition.stages[targetIdx + 1].id
    const err = new Error(`Stage '${laterId}' is already in progress — complete or abandon it before re-opening '${stageId}'.`)
    err.status = 409
    throw err
  }

  const branchName = stageBranchName(slug, stageId)
  const client = createGitLabClient(gitlabBase)
  if (await client.branchExists(branchName)) {
    const err = new Error(`Stage branch "${branchName}" already exists`)
    err.status = 409
    throw err
  }

  const previousStage = bootstrapInstance.stage

  // Same ordering as the Azure DevOps/GitHub paths above: written to `main` first, so the branch
  // created `from: 'main'` right after already inherits the reopened `instance.yaml`.
  const nextInstance = await recordInstanceReopened(slug, stageId, previousStage, { gitlab: gitlabBase })

  await client.createBranch(branchName, { from: 'main' })

  try {
    await client.writeFile(gitlabInstancePath(slug), stringifyInstanceYAML(nextInstance), {
      branch: branchName,
      message: `Re-open stage '${stageId}' of instance '${slug}' (was at '${previousStage}')`,
    })
  } catch (_) {
    // Ignore — re-open already succeeded; audit is best-effort, same as the Azure DevOps/GitHub paths.
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    branch: branchName,
    previousStage,
    reopened: nextInstance.reopened,
    workItemSync: null,
  }
}
