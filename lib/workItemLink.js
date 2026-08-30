import { loadDefinition } from './definition.js'
import { readInstance, recordInstanceWorkItemLink, instanceDefinitionVersion } from './instance.js'
import { listRegisteredInstances } from './instanceRegistry.js'
import { findStageBranch } from './stageBranch.js'
import { checkGate, formatGateOutstanding } from './check.js'
import {
  createAzureDevOpsWorkItemsClient,
  AzureDevOpsAuthenticationError,
  GANTRY_WORK_ITEM_TAG,
} from './azureDevOpsWorkItemsClient.js'

/**
 * The work item type used for a linked instance's parent/stage work items when the caller doesn't configure one explicitly (#95/#103's "configurable, with a sensible default" acceptance criterion). "Task" is the one work item type every stock Azure DevOps process template (Basic, Agile, Scrum, CMMI) ships as a valid child of a parent work item, so it's a safe default regardless of which process template an organization's project uses — unlike, say, "User Story" (Agile/Scrum only) or "Requirement" (CMMI only). A caller who wants their own process template's own type instead passes `workItemType` explicitly to `linkInstanceToWorkItem`.
 */
export const DEFAULT_WORK_ITEM_TYPE = 'Task'

// The instance-data read options (local vs. Azure-DevOps-backed) implied by `options.azureDevOps` — this is the instance's own *data storage* location, wholly independent of `link.organization`/`link.project` below (the Work Items API's own org/project, see linkInstanceToWorkItem's own doc comment on `recordInstanceWorkItemLink`).
function instanceReadOptions(options) {
  return options.azureDevOps ? { azureDevOps: options.azureDevOps } : { instancesDir: options.instancesDir }
}

/**
 * Links `slug` to an Azure DevOps parent work item (`link.parentId`, in `link.organization`/`link.project`) and auto-creates one child work item per stage in the instance's own definition underneath it (#95/#103's second acceptance criterion) — one `createChildWorkItem` call per stage, of type `link.workItemType` (defaulting to `DEFAULT_WORK_ITEM_TYPE`). Once every child is created, records the link — `{ organization, project, workItemType, parentId, baseUrl?, stages: { [stageId]: childWorkItemId } }` — on the instance via `recordInstanceWorkItemLink` (lib/instance.js).
 *
 * Throws if the instance is already linked (unlinking/re-linking isn't supported yet — the caller sees exactly which work item it's already linked to, rather than this silently creating a second, orphaned set of child work items). Throws (without recording anything) if the definition has no stages, or if any child work item's creation fails partway through — in the latter case the error names which stages already got a child work item created for them (each one a real, now-orphaned Azure DevOps work item this ticket's scope doesn't attempt to roll back), so the caller isn't left unable to account for what Azure DevOps already has.
 *
 * `options.azureDevOps`/`options.instancesDir` select the instance's own *data* storage backend (local vs. Azure DevOps), exactly as every other dual-backend function in this codebase — unaffected by, and never assumed to match, `link.organization`/`link.project` (the Work Items API's own org/project a linked work item lives in).
 */
export async function linkInstanceToWorkItem(slug, link, options = {}) {
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
      // A rejected PAT propagates as-is (not wrapped into the generic partial-failure message below) so the server's credential-gating layer (lib/server.js's withAzureDevOpsCredential-style `err instanceof AzureDevOpsAuthenticationError` check) can still turn it into the structured "authentication required" response, the same as every other Azure-DevOps-backed route in this codebase.
      if (err instanceof AzureDevOpsAuthenticationError) throw err
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
      if (entry.location.kind === 'local') {
        const instance = await readInstance(entry.slug, { instancesDir })
        if (!instance.workItem) continue
        results.push(await tagLinkedWorkItems(entry.slug, { instancesDir, pat: instancePat }))
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
 * The confirmed half of #95/#103's read-write sync: given a gate has genuinely passed (re-checked here via `checkGate`, never trusted from an earlier client-side check — the same defense-in-depth every other server-side mutation in this codebase applies), pushes a new `System.State` to that stage's linked work item, drawn from `pickPassedState` above. The *confirmation* itself is the caller's responsibility (the web form's confirm-before-push modal, #103) — this function is only ever called after a user has already confirmed; declining the confirmation simply never calls this at all, leaving the work item's state genuinely untouched (#103's "declining leaves the work item's state unchanged" acceptance criterion — trivially true, since nothing here runs).
 *
 * Throws if the gate hasn't passed, if the instance isn't linked to a work item at all, or if it's linked but has no child work item recorded for the gate's own stage.
 */
export async function syncGatePassToWorkItem(slug, { gate } = {}, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const checkOptions = options.azureDevOps
    ? { azureDevOps: options.azureDevOps, definitionsDir, gate }
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
