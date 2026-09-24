import { join } from 'node:path'
import { loadDefinition } from './definition.js'
import { readInstance, recordInstanceWorkItemLink, instanceDefinitionVersion } from './instance.js'
import { listRegisteredInstances } from './instanceRegistry.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
import { checkGate, formatGateOutstanding } from './check.js'
import { AuthenticationError } from './providerErrors.js'
import { createAzureDevOpsWorkItemsClient, GANTRY_WORK_ITEM_TAG } from './azureDevOpsWorkItemsClient.js'
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { createGitLabWorkItemsClient } from './gitlabWorkItemsClient.js'

/**
 * The work item type used for a linked instance's parent/stage work items when the caller doesn't configure one explicitly (#95/#103's "configurable, with a sensible default" acceptance criterion). "Task" is the one work item type every stock Azure DevOps process template (Basic, Agile, Scrum, CMMI) ships as a valid child of a parent work item, so it's a safe default regardless of which process template an organization's project uses — unlike, say, "User Story" (Agile/Scrum only) or "Requirement" (CMMI only). A caller who wants their own process template's own type instead passes `workItemType` explicitly to `linkInstanceToWorkItem`.
 */
export const DEFAULT_WORK_ITEM_TYPE = 'Task'

// The instance-data read options (local, Azure-DevOps-backed, GitHub-backed or GitLab-backed) implied
// by `options.azureDevOps`/`options.github`/`options.gitlab` — this is the instance's own *data
// storage* location, wholly independent of `link.organization`/`link.project` (or
// `link.owner`/`link.repository`, or `link.namespace`/`link.repository`) below (the work-items API's
// own location, see linkInstanceToWorkItem's own doc comment on `recordInstanceWorkItemLink`).
function instanceReadOptions(options) {
  if (options.azureDevOps) return { azureDevOps: options.azureDevOps }
  if (options.github) return { github: options.github }
  if (options.gitlab) return { gitlab: options.gitlab }
  return { instancesDir: options.instancesDir }
}

// #188: `recordInstanceWorkItemLink` writes to `main`, but an instance with a stage already under way
// is read from that stage's own branch — forked before the link existed — so the link stayed invisible
// (and would have been dropped again whenever that branch's `instance.yaml` merged back). Every stage
// branch that already exists gets the same link; nothing here ever creates a branch.
async function recordLinkOnOpenStageBranches(slug, definition, workItem, options) {
  const [key, findBranch] = options.azureDevOps
    ? ['azureDevOps', findStageBranch]
    : options.github
      ? ['github', findGitHubStageBranch]
      : options.gitlab
        ? ['gitlab', findGitLabStageBranch]
        : []
  if (!key) return
  for (const stage of definition.stages) {
    const branch = await findBranch(options[key], slug, stage.id)
    if (branch) await recordInstanceWorkItemLink(slug, workItem, { ...options, [key]: { ...options[key], branch } })
  }
}

/**
 * Links `slug` to an Azure DevOps parent work item (`link.parentId`, in `link.organization`/`link.project`) and auto-creates one child work item per stage in the instance's own definition underneath it (#95/#103's second acceptance criterion) — one `createChildWorkItem` call per stage, of type `link.workItemType` (defaulting to `DEFAULT_WORK_ITEM_TYPE`). Once every child is created, records the link — `{ organization, project, workItemType, parentId, baseUrl?, stages: { [stageId]: childWorkItemId } }` — on the instance via `recordInstanceWorkItemLink` (lib/instance.js).
 *
 * Throws if the instance is already linked (unlinking/re-linking isn't supported yet — the caller sees exactly which work item it's already linked to, rather than this silently creating a second, orphaned set of child work items). Throws (without recording anything) if the definition has no stages, or if any child work item's creation fails partway through — in the latter case the error names which stages already got a child work item created for them (each one a real, now-orphaned Azure DevOps work item this ticket's scope doesn't attempt to roll back), so the caller isn't left unable to account for what Azure DevOps already has.
 *
 * `options.azureDevOps`/`options.instancesDir` select the instance's own *data* storage backend (local vs. Azure DevOps), exactly as every other dual-backend function in this codebase — unaffected by, and never assumed to match, `link.organization`/`link.project` (the Work Items API's own org/project a linked work item lives in).
 */
export async function linkInstanceToWorkItem(slug, link, options = {}) {
  if (link.provider === 'github') {
    return linkInstanceToGitHubIssue(slug, link, options)
  }
  if (link.provider === 'gitlab') {
    return linkInstanceToGitLabIssue(slug, link, options)
  }
  // #24: every caller before #14 never set `link.provider` at all, so an absent value keeps meaning
  // "Azure DevOps" (the pre-#14 default) below, unchanged. Only a *declared* value other than
  // 'github'/'gitlab'/'azure-devops' is new territory — a provider #14's own binary `github`-or-else
  // check would have silently run the Azure DevOps branch against, against fields it doesn't
  // understand (e.g. a GitLab-shaped `link` with no `organization`/`project` at all). Reported clearly
  // instead, exactly like `getProviderCapabilities`'s own "not registered" error, until that provider's
  // own linker exists.
  if (link.provider !== undefined && link.provider !== 'azure-devops') {
    throw new Error(`Linking an instance to a "${link.provider}" work item is not supported yet.`)
  }

  const { organization, project, parentId, workItemType = DEFAULT_WORK_ITEM_TYPE, pat, baseUrl } = link
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, instanceReadOptions(options))
  if (instance.workItem) {
    throw new Error(
      `Instance "${slug}" is already linked to Azure DevOps work item ${instance.workItem.parentId} ` +
        `(${instance.workItem.organization}/${instance.workItem.project}) — unlinking/re-linking isn't supported yet.`
    )
  }

  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  if (definition.stages.length === 0) {
    throw new Error(`Definition "${definition.id}" has no stages to create child work items for`)
  }

  const client = createAzureDevOpsWorkItemsClient({ organization, project, pat, baseUrl })

  const stages = {}
  for (const stage of definition.stages) {
    const artefactsForGate = definition.artefacts.filter((artefact) => artefact.gate === stage.gate)
    let child
    try {
      child = await client.createChildWorkItem(parentId, workItemType, {
        'System.Title': `${stage.title} — ${slug}`,
        'System.Tags': GANTRY_WORK_ITEM_TAG,
        'System.Description':
          `Tracks the "${stage.title}" stage (stage "${stage.id}", gate "${stage.gate}") of gantry instance "${slug}".\n\n` +
          'Artefacts for this stage:\n' +
          (artefactsForGate.length
            ? artefactsForGate.map((artefact) => `- ${artefact.title}`).join('\n')
            : '- (none)'),
      })
    } catch (err) {
      // A rejected PAT propagates as-is (not wrapped into the generic partial-failure message below) so the server's credential-gating layer (lib/server.js's withAzureDevOpsCredential-style `err instanceof AuthenticationError` check) can still turn it into the structured "authentication required" response, the same as every other Azure-DevOps-backed route in this codebase.
      if (err instanceof AuthenticationError) throw err
      const created = Object.entries(stages).map(([stageId, id]) => `${stageId} (#${id})`)
      throw new Error(
        `Linking instance "${slug}" to work item ${parentId} failed while creating the child work item for ` +
          `stage "${stage.id}" (${err.message}). Child work item(s) already created for: ${
            created.join(', ') || '(none)'
          } — these are real Azure DevOps work items, not yet recorded on the instance, and will need manual ` +
          `cleanup or accounting for before retrying.`
      )
    }
    stages[stage.id] = child.id
  }

  const workItem = {
    organization,
    project,
    workItemType,
    parentId,
    ...(baseUrl ? { baseUrl } : {}),
    stages,
  }

  await recordInstanceWorkItemLink(slug, workItem, options)
  await recordLinkOnOpenStageBranches(slug, definition, workItem, options)
  return workItem
}

// A human-readable name for whichever work item `workItem` already records — shared by
// `linkInstanceToGitHubIssue`'s and `linkInstanceToGitLabIssue`'s own "already linked" error, so
// either linker reports exactly what's already there regardless of which provider it turns out to be
// (#24's own N-way-dispatch reasoning: this used to be a `provider === 'github' ? ... : <assume Azure
// DevOps>` ternary inline, which would have mis-described a GitLab-linked instance as an Azure DevOps
// one).
function describeLinkedWorkItem(workItem) {
  if (workItem.provider === 'github') {
    return `GitHub issue #${workItem.parentNumber} (${workItem.owner}/${workItem.repository})`
  }
  if (workItem.provider === 'gitlab') {
    return `GitLab issue #${workItem.parentIid} (${workItem.namespace}/${workItem.repository})`
  }
  return `Azure DevOps work item ${workItem.parentId} (${workItem.organization}/${workItem.project})`
}

/**
 * The GitHub twin of `linkInstanceToWorkItem` above (#14, docs/adr/0040): links `slug` to an existing
 * parent *issue* (`link.parentNumber`, in `link.owner`/`link.repository`) and creates one child issue
 * per definition stage underneath it — attached as a native sub-issue where the repository supports
 * the feature, falling back to a task-list entry in the parent's body plus a "Part of #<n>" line in the
 * child's otherwise (`lib/githubWorkItemsClient.js`'s `createChildIssue`). There is no work-item *type*
 * to carry (docs/adr/0040: "dropped on GitHub, not emulated") — the recorded `workItem` is
 * `{ provider: 'github', owner, repository, parentNumber, baseUrl?, stages: { [stageId]: issueNumber } }`.
 *
 * Throws under the same conditions `linkInstanceToWorkItem` does: already linked, no stages to create
 * children for, or a mid-loop failure (naming which stages already got a real, now-orphaned GitHub
 * issue created for them).
 */
async function linkInstanceToGitHubIssue(slug, link, options = {}) {
  const { owner, repository, parentNumber, pat, baseUrl } = link
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, instanceReadOptions(options))
  if (instance.workItem) {
    throw new Error(`Instance "${slug}" is already linked to ${describeLinkedWorkItem(instance.workItem)} — unlinking/re-linking isn't supported yet.`)
  }

  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  if (definition.stages.length === 0) {
    throw new Error(`Definition "${definition.id}" has no stages to create child issues for`)
  }

  const client = createGitHubWorkItemsClient({ owner, repository, pat, baseUrl })

  const stages = {}
  for (const stage of definition.stages) {
    const artefactsForGate = definition.artefacts.filter((artefact) => artefact.gate === stage.gate)
    let created
    try {
      created = await client.createChildIssue(
        parentNumber,
        `${stage.title} — ${slug}`,
        `Tracks the "${stage.title}" stage (stage "${stage.id}", gate "${stage.gate}") of gantry instance "${slug}".\n\n` +
          'Artefacts for this stage:\n' +
          (artefactsForGate.length
            ? artefactsForGate.map((artefact) => `- ${artefact.title}`).join('\n')
            : '- (none)')
      )
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      const createdSoFar = Object.entries(stages).map(([stageId, number]) => `${stageId} (#${number})`)
      throw new Error(
        `Linking instance "${slug}" to issue #${parentNumber} failed while creating the child issue for ` +
          `stage "${stage.id}" (${err.message}). Child issue(s) already created for: ${
            createdSoFar.join(', ') || '(none)'
          } — these are real GitHub issues, not yet recorded on the instance, and will need manual cleanup or ` +
          `accounting for before retrying.`
      )
    }
    stages[stage.id] = created.issue.number
  }

  const workItem = {
    provider: 'github',
    owner,
    repository,
    parentNumber,
    ...(baseUrl ? { baseUrl } : {}),
    stages,
  }

  await recordInstanceWorkItemLink(slug, workItem, options)
  await recordLinkOnOpenStageBranches(slug, definition, workItem, options)
  return workItem
}

/**
 * The GitLab twin of `linkInstanceToGitHubIssue` above (#30, ADR-0041): links `slug` to an existing
 * parent *issue* (`link.parentIid`, GitLab's own project-scoped issue number, in
 * `link.namespace`/`link.repository`) and creates one child issue per definition stage underneath it —
 * attached via the task-list-plus-"Part of" convention, GitLab's only hierarchy mode here
 * (`lib/gitlabWorkItemsClient.js`'s `createChildIssue` — see its own doc comment on why there's no
 * native relation to attempt first, unlike GitHub's sub-issues). There is no work-item *type* to carry
 * either (ADR-0040/0041: "dropped, not emulated") — the recorded `workItem` is `{ provider: 'gitlab',
 * namespace, repository, parentIid, baseUrl?, stages: { [stageId]: issueIid } }`.
 *
 * Throws under the same conditions `linkInstanceToGitHubIssue` does: already linked, no stages to
 * create children for, or a mid-loop failure (naming which stages already got a real, now-orphaned
 * GitLab issue created for them).
 */
async function linkInstanceToGitLabIssue(slug, link, options = {}) {
  const { namespace, repository, parentIid, pat, baseUrl } = link
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, instanceReadOptions(options))
  if (instance.workItem) {
    throw new Error(`Instance "${slug}" is already linked to ${describeLinkedWorkItem(instance.workItem)} — unlinking/re-linking isn't supported yet.`)
  }

  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  if (definition.stages.length === 0) {
    throw new Error(`Definition "${definition.id}" has no stages to create child issues for`)
  }

  const client = createGitLabWorkItemsClient({ namespace, repository, pat, baseUrl })

  const stages = {}
  for (const stage of definition.stages) {
    const artefactsForGate = definition.artefacts.filter((artefact) => artefact.gate === stage.gate)
    let created
    try {
      created = await client.createChildIssue(
        parentIid,
        `${stage.title} — ${slug}`,
        `Tracks the "${stage.title}" stage (stage "${stage.id}", gate "${stage.gate}") of gantry instance "${slug}".\n\n` +
          'Artefacts for this stage:\n' +
          (artefactsForGate.length
            ? artefactsForGate.map((artefact) => `- ${artefact.title}`).join('\n')
            : '- (none)')
      )
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      const createdSoFar = Object.entries(stages).map(([stageId, iid]) => `${stageId} (#${iid})`)
      throw new Error(
        `Linking instance "${slug}" to issue #${parentIid} failed while creating the child issue for ` +
          `stage "${stage.id}" (${err.message}). Child issue(s) already created for: ${
            createdSoFar.join(', ') || '(none)'
          } — these are real GitLab issues, not yet recorded on the instance, and will need manual cleanup or ` +
          `accounting for before retrying.`
      )
    }
    stages[stage.id] = created.issue.iid
  }

  const workItem = {
    provider: 'gitlab',
    namespace,
    repository,
    parentIid,
    ...(baseUrl ? { baseUrl } : {}),
    stages,
  }

  await recordInstanceWorkItemLink(slug, workItem, options)
  await recordLinkOnOpenStageBranches(slug, definition, workItem, options)
  return workItem
}

/**
 * Backfills the Gantry tag on stage work items already recorded by a linked
 * instance. The instance record is the authoritative boundary here: the
 * parent was selected by the user and arbitrary work items in that hierarchy
 * must never be treated as Gantry-created. The operation is idempotent and
 * reports whether each recorded child needed an update.
 */
export async function tagLinkedWorkItems(slug, options = {}) {
  const instance = await readInstance(slug, instanceReadOptions(options))
  if (!instance.workItem) {
    throw new Error(`Instance "${slug}" is not linked to an Azure DevOps work item`)
  }

  const client = createAzureDevOpsWorkItemsClient({
    organization: instance.workItem.organization,
    project: instance.workItem.project,
    pat: options.pat ?? options.azureDevOps?.pat,
    baseUrl: instance.workItem.baseUrl,
  })
  const workItemIds = [...new Set(Object.values(instance.workItem.stages ?? {}))]
  let updated = 0
  let alreadyTagged = 0

  for (const workItemId of workItemIds) {
    const result = await client.ensureWorkItemTag(workItemId)
    if (result.updated) updated += 1
    else alreadyTagged += 1
  }

  return { slug, workItemIds, updated, alreadyTagged }
}

/**
 * Backfills every linked instance known to this Gantry deployment. Unlinked
 * instances are skipped, while each linked instance keeps its own persisted
 * work-item location and child-ID boundary. `options.patsBySlug` can provide
 * the effective PAT for each instance; `options.pat` is the fallback. A
 * failure for one instance is reported and does not prevent later instances
 * from being processed.
 */
export async function tagAllLinkedWorkItems(options = {}) {
  // WI #356: `instancesDir` is the workspaces root here — a directory-backed entry's own concrete
  // data directory is `join(instancesDir, entry.workspace)`, decided per entry from the registry
  // (`lib/instanceRegistry.js`'s `workspace` field), the same as every other multi-instance caller
  // (`lib/registry.js`'s `listRegistry`) now does.
  const instancesDir = options.instancesDir ?? 'instances'
  const pat = options.pat ?? options.azureDevOps?.pat
  const results = []
  const failed = []

  for (const entry of listRegisteredInstances({
    instancesDir,
    registryPath: options.registryPath,
  })) {
    const instancePat = options.patsBySlug?.[entry.slug] ?? options.patForInstance?.(entry) ?? pat
    try {
      if (entry.location.kind === 'directory') {
        const localInstancesDir = join(instancesDir, entry.workspace)
        const instance = await readInstance(entry.slug, { instancesDir: localInstancesDir })
        if (!instance.workItem) continue
        results.push(await tagLinkedWorkItems(entry.slug, { instancesDir: localInstancesDir, pat: instancePat }))
        continue
      }

      const azureDevOps = { ...entry.location, pat: instancePat }
      const instance = await readInstance(entry.slug, { azureDevOps })
      if (!instance.workItem) continue
      const branch = await findStageBranch(azureDevOps, entry.slug, instance.stage)
      results.push(
        await tagLinkedWorkItems(entry.slug, {
          instancesDir,
          pat: instancePat,
          azureDevOps: branch ? { ...azureDevOps, branch } : azureDevOps,
        })
      )
    } catch (err) {
      failed.push({ slug: entry.slug, error: err.message })
    }
  }

  return {
    updated: results.reduce((total, result) => total + result.updated, 0),
    alreadyTagged: results.reduce((total, result) => total + result.alreadyTagged, 0),
    instances: results,
    failed,
  }
}

/**
 * Chooses the state to push to a stage's work item once its gate has passed, drawn from that work item type's own actual valid states — never a Gantry-invented fixed list (#95/#103's final acceptance criterion), since different process templates give the same work item type different state names (e.g. Basic's Task: New/Active/Closed vs. Scrum's Task: To Do/In Progress/Done). Azure DevOps's own state *category* (not name) is what's actually comparable across templates: this prefers a "Completed"-category state (the category every template's own gate-closing state carries), falling back to "Resolved" and finally the last state the type reports, so this always resolves to *some* real state regardless of which template's work item type is configured.
 */
export function pickPassedState(states) {
  if (!states || states.length === 0) {
    throw new Error('This work item type reports no states to choose a "gate passed" state from')
  }
  const completed = states.find((s) => s.category === 'Completed')
  if (completed) return completed.name
  const resolved = states.find((s) => s.category === 'Resolved')
  if (resolved) return resolved.name
  return states[states.length - 1].name
}

/**
 * The confirmed half of #95/#103's read-write sync: given a gate has genuinely passed (re-checked here via `checkGate`, never trusted from an earlier client-side check — the same defense-in-depth every other server-side mutation in this codebase applies), pushes a new state to that stage's linked work item — a new `System.State` for an Azure DevOps work item, or the stage's own issue closed as completed for a GitHub one (#14, docs/adr/0040: GitHub issues have no analogue of a configurable work-item state, so "gate passed" is expressed as its own binary "done"). The *confirmation* itself is the caller's responsibility (the web form's confirm-before-push modal, #103) — this function is only ever called after a user has already confirmed; declining the confirmation simply never calls this at all, leaving the work item's state genuinely untouched (#103's "declining leaves the work item's state unchanged" acceptance criterion — trivially true, since nothing here runs). Never gates stage advancement either way — a linked work item stays a tracking surface only (docs/adr/0040, CONTEXT.md's **Check gate & sync work item**).
 *
 * Throws if the gate hasn't passed, if the instance isn't linked to a work item at all, or if it's linked but has no child work item recorded for the gate's own stage.
 */
export async function syncGatePassToWorkItem(slug, { gate } = {}, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const checkOptions = options.azureDevOps
    ? { azureDevOps: options.azureDevOps, definitionsDir, gate }
    : options.github
      ? { github: options.github, definitionsDir, gate }
      : options.gitlab
        ? { gitlab: options.gitlab, definitionsDir, gate }
        : { instancesDir: options.instancesDir, definitionsDir, gate }
  const checkResult = await checkGate(slug, checkOptions)

  if (!checkResult.pass) {
    throw new Error(
      `Gate "${checkResult.gate}" (stage "${checkResult.stage.id}") has not passed for instance "${slug}" — ` +
        `outstanding: ${formatGateOutstanding(checkResult)} — nothing to sync`
    )
  }

  const instance = await readInstance(slug, instanceReadOptions(options))
  if (!instance.workItem) {
    throw new Error(`Instance "${slug}" is not linked to an Azure DevOps work item`)
  }
  const workItemId = instance.workItem.stages?.[checkResult.stage.id]
  if (!workItemId) {
    throw new Error(`Instance "${slug}" has no linked work item for stage "${checkResult.stage.id}"`)
  }

  if (instance.workItem.provider === 'github') {
    const client = createGitHubWorkItemsClient({
      owner: instance.workItem.owner,
      repository: instance.workItem.repository,
      pat: options.pat,
      baseUrl: instance.workItem.baseUrl,
    })
    const updated = await client.updateIssue(workItemId, { state: 'closed', state_reason: 'completed' })
    return {
      slug,
      stage: checkResult.stage,
      gate: checkResult.gate,
      workItemId,
      state: 'closed',
      workItem: updated,
    }
  }

  // #30, mirroring the GitHub branch above (docs/adr/0040/0041): GitLab issues have no configurable
  // work-item state either, and GitLab's own state transition is `state_event: 'close'` rather than a
  // bare `state` field — the one shape difference from `lib/gitlabWorkItemsClient.js`'s own
  // `updateIssue` doc comment. Independent of any Merge Request (#30's own acceptance criterion): this
  // pushes straight off the stage's content gate, never touching (or reading) sign-off state at all.
  if (instance.workItem.provider === 'gitlab') {
    const client = createGitLabWorkItemsClient({
      namespace: instance.workItem.namespace,
      repository: instance.workItem.repository,
      pat: options.pat,
      baseUrl: instance.workItem.baseUrl,
    })
    const updated = await client.updateIssue(workItemId, { state_event: 'close' })
    return {
      slug,
      stage: checkResult.stage,
      gate: checkResult.gate,
      workItemId,
      state: 'closed',
      workItem: updated,
    }
  }
  // #24 — see linkInstanceToWorkItem's own comment: an absent `provider` still means Azure DevOps
  // (every work item linked before #14), only a genuinely different declared provider is unhandled.
  if (instance.workItem.provider !== undefined && instance.workItem.provider !== 'azure-devops') {
    throw new Error(`Syncing a "${instance.workItem.provider}" work item is not supported yet.`)
  }

  const client = createAzureDevOpsWorkItemsClient({
    organization: instance.workItem.organization,
    project: instance.workItem.project,
    pat: options.pat,
    baseUrl: instance.workItem.baseUrl,
  })
  const states = await client.getWorkItemTypeStates(instance.workItem.workItemType)
  const state = pickPassedState(states)
  const updated = await client.updateWorkItem(workItemId, { 'System.State': state })

  return {
    slug,
    stage: checkResult.stage,
    gate: checkResult.gate,
    workItemId,
    state,
    workItem: updated,
  }
}
