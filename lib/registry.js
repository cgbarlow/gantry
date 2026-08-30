import { join } from 'node:path'
import { readInstance, instanceDefinitionVersion } from './instance.js'
import { loadDefinition } from './definition.js'
import { evaluateStage } from './status.js'
import { listRegisteredInstances } from './instanceRegistry.js'
import { findWorkspaceByLocation } from './workspaceRegistry.js'
import { findStageBranch } from './stageBranch.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'
import { localFilesystemStorage as storage } from './storage.js'
import { instanceNumbersFor, formatInstanceRef } from './numberRegistry.js'

function stageRowFields(definition, stage, instance) {
  return {
    stageNumber: definition.stages.indexOf(stage) + 1,
    stageCount: definition.stages.length,
    stageTitle: stage.title,
    pullRequestId: instance.pullRequests?.[stage.id] ?? null,
    pullRequestStatus: instance.pullRequestStatuses?.[stage.id] ?? null,
  }
}

function localUpdatedAt(slug, instancesDir) {
  const instancePath = join(instancesDir, slug)
  const paths = [
    join(instancePath, 'instance.yaml'),
    ...storage
      .listDir(join(instancePath, 'modules'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(instancePath, 'modules', name)),
  ]
  const latestMtime = Math.max(...paths.map((path) => storage.stat(path).mtimeMs))
  return new Date(latestMtime).toISOString()
}

function remoteUpdatedAt(commit) {
  return commit?.committer?.date ?? commit?.author?.date ?? null
}

// Adds a row's numeric reference fields (WI200, docs/adr/0024) — `workspaceNumber`/`instanceNumber`/`ref` — assigned lazily (on first list, if this slug doesn't have one yet) so every existing row, including one created before this feature shipped, gets numbered the moment anything lists the registry.
function withNumericRef(row, instancesDir) {
  const { workspaceNumber, instanceNumber } = instanceNumbersFor(row.slug, { instancesDir })
  return { ...row, workspaceNumber, instanceNumber, ref: formatInstanceRef({ workspaceNumber, instanceNumber }) }
}

// One local instance's registry row, or `null` if its registered slug has no instance.yaml on disk anymore (a stale entry — see listRegistry's own comment on why that's skipped rather than failing the whole listing). Factored out of listRegistry so both its sync (local-only) and async (mixed local/Azure-DevOps) branches build local rows identically.
function buildLocalRow(slug, instancesDir, definitionsDir) {
  let instance
  try {
    instance = readInstance(slug, { instancesDir })
  } catch (err) {
    if (/^No instance /.test(err.message)) return null
    throw err
  }
  const definitionId = instance.definition
  const stageId = instance.stage
  const definition = loadDefinition(definitionId, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }
  const { complete } = evaluateStage(definition, stage, slug, { instancesDir })
  const row = {
    slug,
    definition: definitionId,
    stage: stageId,
    status: complete ? 'complete' : 'incomplete',
    // The instance record's own stored `assignee` (#97) — no longer derived by scanning the current stage's modules for a first non-empty frontmatter `owner`. That module-level convention (Design Authority sign-off, docs/adr/0001) is untouched; it just no longer feeds this row.
    assignee: instance.assignee ?? '',
    ...stageRowFields(definition, stage, instance),
    updatedAt: localUpdatedAt(slug, instancesDir),
  }
  if (instance.workItem) row.workItem = instance.workItem
  return row
}

// The row's `workspace` field (#102): every Azure-DevOps-backed row is grouped, on the dashboard, by the workspace (#96) backing its location — `{ organization, project, repository, baseUrl? }` is already resolved to a real, registered workspace by the time an instance is registered against it (see lib/instanceRegistry.js's normalizeAzureDevOpsLocation), so this is always found, never auto-created here. A local instance has no workspace at all (Workspace is an Azure-DevOps-repo concept only, per spec #95) — buildLocalRow simply never sets this field, rather than setting it to `null`.
function rowWorkspace(location, instancesDir) {
  const workspace = findWorkspaceByLocation(location, { instancesDir })
  if (!workspace) return undefined
  return {
    id: workspace.id,
    organization: workspace.organization,
    project: workspace.project,
    repository: workspace.repository,
    ...(workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
    owner: workspace.owner,
  }
}

// The Azure-DevOps-backed half of buildLocalRow (#93) — the exact same row shape, read from `location`'s Azure DevOps repo instead of instancesDir. `pat` is the caller's own Azure DevOps credential (lib/credential.js's `getCredential(req)`); with none supplied, this entry is skipped without even attempting a network call.
//
// Unlike buildLocalRow (which still throws on a genuine *local* read failure — a deliberate, tested choice, since that's the same trust/failure domain as the server itself), *any* failure reading an Azure-DevOps-backed entry — a rejected/expired PAT, a network error, an Azure DevOps outage, a malformed instance.yaml pointing at an unknown stage, etc. — is caught here and simply leaves that one entry out of the unified list (returns `null`), rather than failing the whole listing for every other — possibly unrelated, possibly purely local — instance in it. A remote system this server doesn't control is a fundamentally less predictable failure domain than its own local disk; letting one unreachable Azure DevOps org take down visibility of every local instance too (verified: a single unreachable registered entry used to turn the whole `GET /api/instances` into a 500) is a worse outcome than that one entry's row simply being temporarily absent.
//
// This still must not go completely silent, though: this codebase has no other server-side logging at all, so without the `console.error` below, a genuine, persistent problem (a rejected PAT, a malformed remote instance.yaml, a bug in this very function) would be indistinguishable from "temporarily unreachable" with zero trace anywhere an operator or developer could notice it — this is the one diagnostic breadcrumb for exactly that case.
async function buildAzureDevOpsRow(slug, location, definitionsDir, pat, instancesDir) {
  if (!pat) return null
  const azureDevOpsBase = { ...location, pat }
  try {
    const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
    const definitionId = bootstrapInstance.definition
    const stageId = bootstrapInstance.stage
    const definition = loadDefinition(definitionId, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
    const stage = definition.stages.find((s) => s.id === stageId)
    if (!stage) {
      throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
    }

    // Read-only (#122): the dashboard listing every instance must never itself start a stage's branch lifecycle — findStageBranch only reports a branch that already exists (work has genuinely begun on this stage), falling back to 'main' (the bootstrap read above) otherwise.
    const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
    const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
    const instance = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance

    const { complete } = await evaluateStage(definition, stage, slug, { azureDevOps })
    // Read after evaluation so a lazy module migration, if one was needed, is included in the row's last-updated timestamp.
    const latestCommit = await createAzureDevOpsClient(azureDevOpsBase).getLatestCommit({ branch: branch ?? 'main' })
    const row = {
      slug,
      definition: definitionId,
      stage: stageId,
      status: complete ? 'complete' : 'incomplete',
      // See buildLocalRow's own comment — the instance record's own stored `assignee` (#97), not a module-frontmatter-derived rollup.
      assignee: instance.assignee ?? '',
      // See rowWorkspace's own comment (#102) — the workspace this instance's location belongs to, so the dashboard can group rows by it.
      workspace: rowWorkspace(location, instancesDir),
      ...stageRowFields(definition, stage, instance),
      updatedAt: remoteUpdatedAt(latestCommit),
    }
    if (instance.workItem) row.workItem = instance.workItem
    return row
  } catch (err) {
    console.error(`lib/registry.js: omitting Azure-DevOps-backed instance "${slug}" from GET /api/instances — ${err.message}`)
    return null
  }
}

/**
 * The registry: every instance gantry knows about, enriched with what a listing screen needs to render a row without fetching each instance individually — name (`slug`), `definition`, current `stage`, an overall `status` ('complete'/'incomplete') for that stage, its stored `assignee`, stage position/title, current-stage PR presence/status, and last-updated timestamp.
 *
 * "Every instance gantry knows about" means every slug the instance registry (lib/instanceRegistry.js, #89) knows about — that module's auto-backfill means this is still every local instance on disk (the examples/demo-cli/demo-web fixtures, anything made via `gantry new`, any test's temp instance), with zero migration step; existing fields and ordering retain their prior semantics while the dashboard metadata fields are additive.
 *
 * Azure-DevOps-backed entries (registered by `POST /api/instances`, #93) are included in the same unified list, read from their own repo instead of `instancesDir` (see buildAzureDevOpsRow) — this is what makes a newly Azure-DevOps-backed instance "appear in the dashboard listing" once created. Because reading one of those requires a real network call, this function returns a plain array synchronously exactly as before *only* when nothing registered is Azure-DevOps-backed (every existing caller's case); the moment at least one such entry is registered, this returns a Promise instead — the same "sync unless Azure DevOps is involved" contract every other dual-backend function in this codebase (readInstance/readModule/writeModule/evaluateStage/getStatus) already has, just decided here by what's *registered* rather than by an option the caller passed for a single instance. `options.pat` is the caller's own Azure DevOps credential (lib/credential.js's `getCredential(req)`), forwarded to each Azure-DevOps-backed entry's read. The one additional Git commit read per remote row is used only for `updatedAt`; PR review state is never fetched here.
 *
 * Distinct from `listInstances` (the directory-scan primitive, which reports `stagesWithData` for every stage rather than a single current-stage status) — this is the shape `GET /api/instances` wants, not a replacement for that lower-level listing.
 *
 * `status` reflects the instance's *current* stage only — the same stage `gantry status` would report against — not every stage the instance has touched. `assignee` (#97) is a plain, stage-independent field on the instance record itself, so it stays the same across stage transitions rather than being recomputed per stage the way `status` is.
 *
 * Archived instances (#223) are excluded by default — an archived instance drops off the
 * dashboard listing with no code change here, since `listRegisteredInstances` filters them out
 * upstream. `options.includeArchived` (surfaced as `GET /api/instances?archived=1`) includes them
 * instead, each row then additionally carrying an `archived` boolean so the "show archived /
 * restore" view can separate the two; without the option no row has that key at all.
 *
 * An Azure-DevOps-backed row also carries a `workspace` field (#102) — the `{ id, organization, project, repository, owner }` of the workspace (lib/workspaceRegistry.js, #96) its location belongs to, so the Workspaces dashboard can group rows by it. A local row has no `workspace` field at all (Workspace is an Azure-DevOps-repo concept only) — never `null`, so a purely-local registry's output shape is unchanged from before this ticket.
 */
// Carries an archived entry's `archived` flag (#223) onto its built row, but only for the
// "show archived" view (`options.includeArchived`) — with the option absent, `listRegisteredInstances`
// has already filtered archived entries out and no row gains an `archived` key, so the default
// listing's shape is byte-for-byte what it was before this ticket.
function withArchivedFlag(row, entry, includeArchived) {
  if (!includeArchived) return row
  return { ...row, archived: Boolean(entry.archived) }
}

export function listRegistry(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const includeArchived = Boolean(options.includeArchived)

  // Already sorted by slug — listRegisteredInstances's own contract — so no further sorting is needed on either branch below.
  const registered = listRegisteredInstances({ instancesDir, registryPath: options.registryPath, includeArchived })

  if (!registered.some((entry) => entry.location.kind === 'azureDevOps')) {
    return registered
      .map((entry) => {
        const row = buildLocalRow(entry.slug, instancesDir, definitionsDir)
        return row === null ? null : withArchivedFlag(withNumericRef(row, instancesDir), entry, includeArchived)
      })
      .filter((row) => row !== null)
  }

  return (async () => {
    const rows = []
    for (const entry of registered) {
      const row =
        entry.location.kind === 'local'
          ? buildLocalRow(entry.slug, instancesDir, definitionsDir)
          : await buildAzureDevOpsRow(entry.slug, entry.location, definitionsDir, options.pat, instancesDir)
      if (row !== null) rows.push(withArchivedFlag(withNumericRef(row, instancesDir), entry, includeArchived))
    }
    return rows
  })()
}
