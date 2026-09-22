import { join } from 'node:path'
import { readInstance, instanceDefinitionVersion } from './instance.js'
import { loadDefinition } from './definition.js'
import { findDefinitionHomeDefinitionsDir } from './definitionHome.js'
import { evaluateStage } from './status.js'
import { listRegisteredInstances, backfillProviderInstances, hasUndiscoveredProviderWorkspaces } from './instanceRegistry.js'
import { findWorkspaceByLocation } from './workspaceRegistry.js'
import { readWorkspaceJson } from './workspaceDirectory.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
import { resolveContentStore } from './providerRegistry.js'
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

// Adds a row's numeric reference fields (WI200, docs/adr/0024) — `workspaceNumber`/`instanceNumber`/`ref` — assigned lazily (on first list, if this slug doesn't have one yet) so every existing row, including one created before this feature shipped, gets numbered the moment anything lists the registry. `workspace` (a directory entry's folder name, `undefined` for an Azure-DevOps-backed one) is forwarded so `instanceNumbersFor`/`lib/instanceRegistry.js` can resolve this slug's scope directly rather than searching every workspace for it (WI #356) — the caller here already knows it, from the same registry entry this row was built from.
function withNumericRef(row, workspacesDir, workspace) {
  const { workspaceNumber, instanceNumber } = instanceNumbersFor(row.slug, { instancesDir: workspacesDir, workspace })
  return { ...row, workspaceNumber, instanceNumber, ref: formatInstanceRef({ workspaceNumber, instanceNumber }) }
}

// WI #383 (ADR-0036): `instancesDir` here is already the *workspace's own* folder (the caller passes
// `directoryRowInstancesDir(workspacesDir, entry)`, sibling to that workspace's own `definitions/`
// folder if it has one) — so "resolves the pinned definition from the workspace first, then falls back
// to the library" is a single existence check against that one sibling folder, not a scan of every
// workspace the way `lib/definitionHome.js`'s equivalent (used where the caller doesn't already know
// which workspace) has to do.
// WI #386: falls through to `findDefinitionHomeDefinitionsDir` (packaged library, every server
// workspace, and — the point of this ticket — every cached library repo) when `definitionId` isn't
// this instance's own workspace's `definitions/` folder, rather than assuming it's always the plain
// packaged `definitionsDir` passed in. This is what makes "an instance already pinned to a
// library-repo definition keeps working from the cache" true for the dashboard/status row a running
// instance is read through, not just the definitions-editor read paths `lib/definitionHome.js`'s
// other callers already covered. Falls back to the caller's own `definitionsDir` (the pre-existing
// behavior) if the id genuinely isn't found anywhere — `loadDefinition` below then throws its own
// clear "unknown definition" error rather than this function silently guessing.
function localRowDefinitionsDir(instanceOwnDir, definitionsDir, definitionId, workspacesRootDir) {
  const workspaceDefinitionsDir = join(instanceOwnDir, 'definitions')
  if (storage.exists(join(workspaceDefinitionsDir, definitionId))) return workspaceDefinitionsDir
  return findDefinitionHomeDefinitionsDir(definitionId, { definitionsDir, instancesDir: workspacesRootDir }) ?? definitionsDir
}

// One local instance's registry row, or `null` if its registered slug has no instance.yaml on disk anymore (a stale entry — see listRegistry's own comment on why that's skipped rather than failing the whole listing). Factored out of listRegistry so both its sync (local-only) and async (mixed local/Azure-DevOps) branches build local rows identically.
function buildLocalRow(slug, instancesDir, definitionsDir, workspacesRootDir) {
  let instance
  try {
    instance = readInstance(slug, { instancesDir })
  } catch (err) {
    if (/^No instance /.test(err.message)) return null
    throw err
  }
  const definitionId = instance.definition
  const stageId = instance.stage
  const definition = loadDefinition(definitionId, {
    definitionsDir: localRowDefinitionsDir(instancesDir, definitionsDir, definitionId, workspacesRootDir),
    version: instanceDefinitionVersion(instance),
  })
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

// The GitLab twin of rowGitHubWorkspace above (#35, ADR-0041) — same "nest the repo location under
// its own key" shape, over GitLab's own `{namespace, repository, baseUrl?}` fields.
function rowGitLabWorkspace(location, instancesDir) {
  const workspace = findWorkspaceByLocation(
    { provider: 'gitlab', location: { namespace: location.namespace, repository: location.repository, baseUrl: location.baseUrl } },
    { instancesDir }
  )
  if (!workspace) return undefined
  return {
    kind: 'gitlab',
    id: workspace.id,
    location: {
      namespace: workspace.location.namespace,
      repository: workspace.location.repository,
      ...(workspace.location.baseUrl ? { baseUrl: workspace.location.baseUrl } : {}),
    },
    owner: workspace.owner,
  }
}

// The row's `workspace` field (#102): every Azure-DevOps-backed row is grouped, on the dashboard, by the workspace (#96) backing its location — `{ organization, project, repository, baseUrl? }` is already resolved to a real, registered workspace by the time an instance is registered against it (see lib/instanceRegistry.js's normalizeAzureDevOpsLocation), so this is always found, never auto-created here. A local instance has no workspace at all (Workspace is an Azure-DevOps-repo concept only, per spec #95) — buildLocalRow simply never sets this field, rather than setting it to `null`.
function rowWorkspace(location, instancesDir) {
  const workspace = findWorkspaceByLocation(
    {
      provider: 'azure-devops',
      location: { organization: location.organization, project: location.project, repository: location.repository, baseUrl: location.baseUrl },
    },
    { instancesDir }
  )
  if (!workspace) return undefined
  return {
    kind: 'azureDevOps',
    id: workspace.id,
    organization: workspace.location.organization,
    project: workspace.location.project,
    repository: workspace.location.repository,
    ...(workspace.location.baseUrl ? { baseUrl: workspace.location.baseUrl } : {}),
    owner: workspace.owner,
  }
}

// The GitHub twin of rowWorkspace above (#11). GitHub's own location field is *also* called `owner`
// (the repo owner/org, e.g. `octocat/Hello-World`) — genuinely distinct from `workspace.owner` (the
// gantry-side Workspace Owner person, ADR-0037's own noted collision) — so, unlike the Azure DevOps
// row's flattened shape, this nests the repo location under its own key rather than flattening
// `location.owner` next to `owner` the person, which would silently overwrite one with the other.
function rowGitHubWorkspace(location, instancesDir) {
  const workspace = findWorkspaceByLocation(
    { provider: 'github', location: { owner: location.owner, repository: location.repository, baseUrl: location.baseUrl } },
    { instancesDir }
  )
  if (!workspace) return undefined
  return {
    kind: 'github',
    id: workspace.id,
    location: {
      owner: workspace.location.owner,
      repository: workspace.location.repository,
      ...(workspace.location.baseUrl ? { baseUrl: workspace.location.baseUrl } : {}),
    },
    owner: workspace.owner,
  }
}

// The row's `workspace` field (WI #357) for a directory-backed (server workspace, WI #356) entry —
// the dashboard-grouping counterpart of `rowWorkspace` above, over a server workspace's `workspace.json`
// (`lib/workspaceDirectory.js`, WI #355) instead of an Azure DevOps `lib/workspaceRegistry.js` record.
// `id` is the workspace's own folder name under the workspaces root (`entry.workspace`, already resolved
// by the caller from the same registry entry this row was built from) — the same stable string
// `lib/numberRegistry.js` already uses as this workspace's numbering scope key (WI #356), so grouping and
// numbering agree on what identifies a server workspace without inventing a second id scheme.
//
// A missing or unreadable `workspace.json` (shouldn't happen in practice — `lib/workspaceDirectory.js`'s
// own `listServerWorkspaces` scan, which `lib/instanceRegistry.js`'s auto-backfill relies on to find this
// entry at all, requires one to exist) falls back to a bare `{ kind, id, name: id }` rather than dropping
// the row's `workspace` field entirely — a row always groups by its real workspace, even if that
// workspace's own metadata can't currently be read.
function rowServerWorkspace(workspacesDir, workspaceId) {
  try {
    const record = readWorkspaceJson(workspacesDir, workspaceId)
    return {
      kind: 'directory',
      id: workspaceId,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
    }
  } catch {
    return { kind: 'directory', id: workspaceId, name: workspaceId }
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
    const latestCommit = await resolveContentStore('azure-devops', azureDevOpsBase).getLatestCommit({ branch: branch ?? 'main' })
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

// The GitHub twin of buildAzureDevOpsRow above (#11, stage-branch-aware since #12) — same "any read
// failure just omits this one row rather than failing the whole listing" contract and the same
// diagnostic breadcrumb. Still simpler than its Azure DevOps counterpart: no pull-request summary yet
// (#13), and `latestCommit` stays `null` until #16 gives this client a `getLatestCommit` equivalent.
async function buildGitHubRow(slug, location, definitionsDir, pat, instancesDir) {
  if (!pat) return null
  const githubBase = { ...location, pat }
  try {
    const bootstrapInstance = await readInstance(slug, { github: githubBase })
    const definitionId = bootstrapInstance.definition
    const stageId = bootstrapInstance.stage
    const definition = loadDefinition(definitionId, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
    const stage = definition.stages.find((s) => s.id === stageId)
    if (!stage) {
      throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
    }

    // Read-only (#12, mirroring #122's Azure DevOps contract): the dashboard listing every instance
    // must never itself start a stage's branch lifecycle — findGitHubStageBranch only reports a branch
    // that already exists, falling back to 'main' (the bootstrap read above) otherwise.
    const branch = await findGitHubStageBranch(githubBase, slug, stage.id)
    const github = branch ? { ...githubBase, branch } : githubBase
    const instance = branch ? await readInstance(slug, { github }) : bootstrapInstance

    const { complete } = await evaluateStage(definition, stage, slug, { github })
    const latestCommit = null // #16 — GitHub file-URL/render-provenance ticket adds a getLatestCommit equivalent
    const row = {
      slug,
      definition: definitionId,
      stage: stageId,
      status: complete ? 'complete' : 'incomplete',
      assignee: instance.assignee ?? '',
      workspace: rowGitHubWorkspace(location, instancesDir),
      ...stageRowFields(definition, stage, instance),
      updatedAt: remoteUpdatedAt(latestCommit),
    }
    if (instance.workItem) row.workItem = instance.workItem
    return row
  } catch (err) {
    console.error(`lib/registry.js: omitting GitHub-backed instance "${slug}" from GET /api/instances — ${err.message}`)
    return null
  }
}

// The GitLab twin of buildGitHubRow above (#35, ADR-0041, stage-branch-aware since #29) — same "any
// read failure just omits this one row rather than failing the whole listing" contract and the same
// diagnostic breadcrumb. `latestCommit` stays `null` the same way GitHub's own row does — neither
// client has a `getLatestCommit` equivalent yet.
async function buildGitLabRow(slug, location, definitionsDir, pat, instancesDir) {
  if (!pat) return null
  const gitlabBase = { ...location, pat }
  try {
    const bootstrapInstance = await readInstance(slug, { gitlab: gitlabBase })
    const definitionId = bootstrapInstance.definition
    const stageId = bootstrapInstance.stage
    const definition = loadDefinition(definitionId, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
    const stage = definition.stages.find((s) => s.id === stageId)
    if (!stage) {
      throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
    }

    // Read-only (#29, mirroring #12's GitHub contract): the dashboard listing every instance must
    // never itself start a stage's branch lifecycle — findGitLabStageBranch only reports a branch that
    // already exists, falling back to 'main' (the bootstrap read above) otherwise.
    const branch = await findGitLabStageBranch(gitlabBase, slug, stage.id)
    const gitlab = branch ? { ...gitlabBase, branch } : gitlabBase
    const instance = branch ? await readInstance(slug, { gitlab }) : bootstrapInstance

    const { complete } = await evaluateStage(definition, stage, slug, { gitlab })
    const latestCommit = null
    const row = {
      slug,
      definition: definitionId,
      stage: stageId,
      status: complete ? 'complete' : 'incomplete',
      assignee: instance.assignee ?? '',
      workspace: rowGitLabWorkspace(location, instancesDir),
      ...stageRowFields(definition, stage, instance),
      updatedAt: remoteUpdatedAt(latestCommit),
    }
    if (instance.workItem) row.workItem = instance.workItem
    return row
  } catch (err) {
    console.error(`lib/registry.js: omitting GitLab-backed instance "${slug}" from GET /api/instances — ${err.message}`)
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
 * Every row carries a `workspace` field (WI #357) so the dashboard can group by it uniformly regardless of kind: an Azure-DevOps-backed row's is `{ kind: 'azureDevOps', id, organization, project, repository, owner }` (#102, lib/workspaceRegistry.js, #96); a directory-backed (server workspace) row's is `{ kind: 'directory', id, name, description? }`, read from that workspace's own `workspace.json` (lib/workspaceDirectory.js, WI #355) — `id` is the workspace's folder name under the workspaces root, the same string lib/numberRegistry.js uses as its numbering scope key (WI #356).
 *
 * `options.sharedPats` (#121, parent #109, docs/adr/0047) — the parsed `GANTRY_SHARED_WORKSPACE_PATS`
 * map, `{}` unless a caller supplies one — is the credential a provider-backed row falls back to when
 * `options.pat` (this request's own) is absent, scoped per row to that row's own workspace id and never
 * any other's (see resolveRowCredential). This is a *read* fallback only: nothing in this module ever
 * uses `options.sharedPats` for anything but building a row to return, and `lib/server.js` never passes
 * it into a mutating route's own re-read of `listRegistry`.
 */
// Carries an archived entry's `archived` flag (#223) onto its built row, but only for the
// "show archived" view (`options.includeArchived`) — with the option absent, `listRegisteredInstances`
// has already filtered archived entries out and no row gains an `archived` key, so the default
// listing's shape is byte-for-byte what it was before this ticket.
function withArchivedFlag(row, entry, includeArchived) {
  if (!includeArchived) return row
  return { ...row, archived: Boolean(entry.archived) }
}

// WI #356: `options.instancesDir` is the *workspaces root* now, not any one instance's own
// directory — a directory-backed entry's concrete data directory is `join(workspacesDir, entry.workspace)`,
// decided per row from the registry entry itself (`lib/instanceRegistry.js`'s `workspace` field),
// never assumed to be the root directly the way every entry's data used to sit before this ticket.
function directoryRowInstancesDir(workspacesDir, entry) {
  return join(workspacesDir, entry.workspace)
}

// Row builders for a provider-backed (non-directory) registry entry, keyed by its own
// `location.kind` (#24, ADR-0039). Before this, listRegistry's remote branch was an `if
// (kind === 'github') ... else` that silently treated *any other* kind as Azure DevOps — exactly the
// binary anti-pattern ADR-0039 already rejected, and one a `gitlab`-kind entry (ADR-0041) would have
// hit as soon as one existed, misapplying Azure DevOps's own builder to a GitLab-shaped location. A
// kind with no builder registered here is reported (buildRegistryRow below) and the row omitted, the
// same way every other unreadable remote row already is — never misrouted into whichever builder
// happened to be last. GitLab's own `buildGitLabRow` plugs in here as a one-line addition once it
// exists; no other calls site changes.
const ROW_BUILDERS = {
  github: (entry, definitionsDir, pat, workspacesDir) => buildGitHubRow(entry.slug, entry.location, definitionsDir, pat, workspacesDir),
  gitlab: (entry, definitionsDir, pat, workspacesDir) => buildGitLabRow(entry.slug, entry.location, definitionsDir, pat, workspacesDir),
  azureDevOps: (entry, definitionsDir, pat, workspacesDir) => buildAzureDevOpsRow(entry.slug, entry.location, definitionsDir, pat, workspacesDir),
}

// Resolves the credential a provider-backed row should actually be built with (#121, parent #109,
// docs/adr/0047): the request's own credential (`pat`) when it has one, else `sharedPats`' entry for
// this entry's own workspace id when the deployment has declared that workspace shared
// (`GANTRY_SHARED_WORKSPACE_PATS`, `lib/workspaceBootstrap.js`'s `parseSharedWorkspacePats`), else
// `undefined` — which every `buildGitHubRow`/`buildAzureDevOpsRow`/`buildGitLabRow`'s own
// `if (!pat) return null` already treats as "omit this row", exactly as today. `entry.scopeId` is
// already this entry's own workspace id (`lib/instanceRegistry.js`'s `listRegisteredInstances`/
// `denormalizeEntry` — the same id `rowGitHubWorkspace` and its siblings resolve their `workspace.id`
// from), so a shared credential is only ever looked up under, and therefore only ever tried against,
// the one workspace it was declared for — it can never leak onto a different entry's repo. With
// `sharedPats` empty (the default — nothing set `GANTRY_SHARED_WORKSPACE_PATS`), this always resolves
// to `pat` unchanged, which is what keeps an unconfigured deployment byte-for-byte identical to before
// this ticket.
function resolveRowCredential(entry, pat, sharedPats) {
  return pat || sharedPats[entry.scopeId] || undefined
}

// Builds one provider-backed row, or `null` — either because the builder itself found nothing to
// report (see buildGitHubRow/buildAzureDevOpsRow's own "omit rather than fail the whole listing"
// contract), or because `entry.location.kind` has no registered builder at all, logged with the same
// diagnostic breadcrumb those two functions already use for a genuine read failure.
async function buildRegistryRow(entry, definitionsDir, pat, workspacesDir, sharedPats) {
  const buildRow = ROW_BUILDERS[entry.location.kind]
  if (!buildRow) {
    console.error(`lib/registry.js: omitting instance "${entry.slug}" from GET /api/instances — no row builder registered for location kind "${entry.location.kind}"`)
    return null
  }
  return buildRow(entry, definitionsDir, resolveRowCredential(entry, pat, sharedPats), workspacesDir)
}

// The shared row-building loop behind listRegistry's async branch, factored out so the #112
// Provider-backed-discovery branch below (which needs to re-read `listRegisteredInstances` *after*
// `backfillProviderInstances` has possibly added entries) and the pre-existing "something registered
// is already Provider-backed" branch build rows identically, from whichever `registered` list each
// has in hand. `sharedPats` (#121, docs/adr/0047) is the parsed `GANTRY_SHARED_WORKSPACE_PATS` map,
// `{}` by default — see resolveRowCredential above for how it's applied per entry; a directory entry
// never reaches it at all, since buildLocalRow takes no credential of any kind.
async function buildRegistryRows(registered, workspacesDir, definitionsDir, pat, includeArchived, sharedPats) {
  const rows = []
  for (const entry of registered) {
    const row =
      entry.location.kind === 'directory'
        ? buildLocalRow(entry.slug, directoryRowInstancesDir(workspacesDir, entry), definitionsDir, workspacesDir)
        : await buildRegistryRow(entry, definitionsDir, pat, workspacesDir, sharedPats)
    if (row === null) continue
    if (entry.location.kind === 'directory') row.workspace = rowServerWorkspace(workspacesDir, entry.workspace)
    rows.push(withArchivedFlag(withNumericRef(row, workspacesDir, entry.workspace), entry, includeArchived))
  }
  return rows
}

export function listRegistry(options = {}) {
  const workspacesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const includeArchived = Boolean(options.includeArchived)
  const registryOptions = { instancesDir: workspacesDir, registryPath: options.registryPath, includeArchived }
  // #121 (parent #109, docs/adr/0047): the parsed `GANTRY_SHARED_WORKSPACE_PATS` map
  // (`lib/workspaceBootstrap.js`'s `parseSharedWorkspacePats`, `{ workspaceId: pat }`) — `{}` unless a
  // caller passes one, which is what keeps every existing caller (every write-path re-read in
  // lib/server.js included, per that ADR's "writing always uses the viewer's own credential" rule)
  // byte-for-byte unaffected: nothing to resolve means `resolveRowCredential` always falls through to
  // `pat` unchanged, the exact behavior this function had before this ticket. Only `GET /api/instances`
  // (lib/server.js) actually supplies a non-empty one.
  const sharedPats = options.sharedPats ?? {}

  // #112 (parent #109): a Provider-backed workspace with zero registered instances and a usable
  // credential on this request gets its instances discovered from its own repo before anything else
  // below runs, so they're already ordinary registry entries by the time `listRegisteredInstances` is
  // read for real. `hasUndiscoveredProviderWorkspaces` is a cheap, synchronous, no-network pre-check —
  // the common case (nothing left to discover, or no credential on this request at all) never pays for
  // the async branch below and this function keeps returning a plain array synchronously, exactly as
  // it did before #112. Discovery itself stays scoped to the request's own credential only — a shared
  // credential warms the registry at boot instead (`lib/workspaceBootstrap.js`'s
  // `discoverBootstrapPatInstances`), not here.
  if (hasUndiscoveredProviderWorkspaces({ ...registryOptions, pat: options.pat })) {
    return (async () => {
      await backfillProviderInstances({ ...registryOptions, pat: options.pat })
      const registered = listRegisteredInstances(registryOptions)
      return buildRegistryRows(registered, workspacesDir, definitionsDir, options.pat, includeArchived, sharedPats)
    })()
  }

  // Already sorted by slug — listRegisteredInstances's own contract — so no further sorting is needed on either branch below.
  const registered = listRegisteredInstances(registryOptions)

  if (registered.every((entry) => entry.location.kind === 'directory')) {
    return registered
      .map((entry) => {
        const row = buildLocalRow(entry.slug, directoryRowInstancesDir(workspacesDir, entry), definitionsDir, workspacesDir)
        if (row === null) return null
        row.workspace = rowServerWorkspace(workspacesDir, entry.workspace)
        return withArchivedFlag(withNumericRef(row, workspacesDir, entry.workspace), entry, includeArchived)
      })
      .filter((row) => row !== null)
  }

  return buildRegistryRows(registered, workspacesDir, definitionsDir, options.pat, includeArchived, sharedPats)
}
