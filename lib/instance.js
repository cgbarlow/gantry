import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { loadDefinition } from './definition.js'
import { localFilesystemStorage as storage } from './storage.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsRepoNotFoundError } from './azureDevOpsClient.js'
import { isValidSlug } from './slug.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// Strips inline markdown formatting from a heading so it can be matched against a field's plain-text title (e.g. "## **Business driver**").
function normalizeHeadingText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim()
}

function instanceDir(instancesDir, slug) {
  return join(instancesDir, slug)
}

function modulePath(instancesDir, slug, moduleId) {
  return join(instanceDir(instancesDir, slug), 'modules', `${moduleId}.md`)
}

// Defaults `assignee` to `''` on top of a parsed instance.yaml (#97) — but only when parsing actually produced an object. A blank/malformed instance.yaml parses to `null` (yaml's own documented behavior for empty content), and spreading `null` into an object literal is a silent no-op in JS — naively doing `{ assignee: '', ...parseYAML(text) }` would turn that `null` into `{ assignee: '' }`, masking the read as if it had succeeded and deferring the failure to a later, less clear error deep inside whatever the caller does next (e.g. `loadDefinition` rejecting an `undefined` id) instead of surfacing it immediately at the read itself, the same way every other malformed-instance.yaml case already does.
function withDefaultAssignee(parsed) {
  if (parsed === null || parsed === undefined) return parsed
  return { assignee: '', ...parsed }
}

// Repo-relative paths for an Azure-DevOps-backed instance, under the per-slug `gantry-workspace/<slug>/` subdirectory (docs/adr/0010 and docs/adr/0005-instance-data-in-external-ado-repo.md) rather than repo root — this is what lets one Azure DevOps repo ("workspace", lib/workspaceRegistry.js, #96) host more than one instance, each in its own slug-named subdirectory, instead of the whole repo being exactly one instance's data as it was before #100. Exported so lib/render.js (rendered-artefact output) and lib/repoCheck.js (the wizard's "check repo" probe, and its legacy-root migration routine) build the exact same paths rather than each duplicating this prefix convention.
export const AZURE_DEVOPS_WORKSPACE_ROOT = 'gantry-workspace'

// Every caller of the three path builders below is expected to have already validated `slug` (every client-supplied slug is checked at the HTTP layer, lib/server.js's isValidSlug; every slug discovered from a remote repo's own instance.yaml is checked in lib/repoCheck.js before it's ever used to build a path) — but asserting it again here too, at the one place `slug` actually becomes part of a remote Azure DevOps path, means that protection holds even for a future or overlooked caller that doesn't happen to validate upstream, rather than relying entirely on every call site remembering to.
function assertValidAzureDevOpsSlug(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(`Cannot build an Azure DevOps path for invalid instance slug "${slug}"`)
  }
}

export function azureDevOpsInstancePath(slug) {
  assertValidAzureDevOpsSlug(slug)
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/instance.yaml`
}

export function azureDevOpsModulePath(slug, moduleId) {
  assertValidAzureDevOpsSlug(slug)
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/modules/${moduleId}.md`
}

export function azureDevOpsOutPath(slug, artefactId) {
  assertValidAzureDevOpsSlug(slug)
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/out/${artefactId}.docx`
}

// The pre-#100 repo-root paths (no `gantry-workspace/<slug>/` prefix at all) an Azure-DevOps-backed instance's data used to live at, back when the whole repo was necessarily exactly one instance. Kept only for lib/repoCheck.js's one-time migration routine to detect and move off of — nothing else should ever read or write these once a repo has been migrated.
export const LEGACY_AZURE_DEVOPS_INSTANCE_PATH = 'instance.yaml'
export const LEGACY_AZURE_DEVOPS_MODULES_DIR = 'modules'

/**
 * Builds an Azure DevOps client from the caller-supplied `options.azureDevOps` (`{ organization, project, repository, pat, baseUrl?, branch? }`) — the credential/location "accepted as a plain parameter at this layer" that #82's spec calls for (wiring it from a real HTTP request, or from a lookup keyed on `slug`, is later work). Its *presence* on `options` — never anything read off a fetched `instance.yaml` — is what routes a call through Azure DevOps instead of the local filesystem: for a real Azure-DevOps-backed instance, `instance.yaml` itself lives only in that repo, so there is nothing to read locally first that could tell us where to look.
 *
 * Also returns `branch` — the specific branch every read/write below should target — straight off `options.azureDevOps.branch`, left `undefined` when the caller didn't supply one so every downstream `client.getFileContent`/`writeFile`/`listFolder`/`deleteFile` call falls through to that client's own `'main'` default (#118) rather than this function silently picking a value the caller never asked for. A real per-stage branch (#122) is chosen by the caller, not decided here.
 */
function azureDevOpsClientFor(options) {
  const { organization, project, repository, pat, baseUrl, branch } = options.azureDevOps
  return { client: createAzureDevOpsClient({ organization, project, repository, pat, baseUrl }), branch }
}

function renderModuleFile(moduleSpec, { status = 'draft', owner = '' } = {}) {
  const frontmatter = stringifyYAML({ module: moduleSpec.id, status, owner }).trimEnd()
  const sections = moduleSpec.fields
    .map((field) => `## ${field.title}\n\n`)
    .join('\n')
  // New document heading scale (ADR-0016): the module's own title leads the document at `#`, each field heading sits at `##`, and author content starts at `###`.
  return `---\n${frontmatter}\n---\n\n# ${moduleSpec.title}\n\n${sections}`
}

/**
 * `gantry new <definitionId> <slug>`: creates instances/<slug>/instance.yaml plus one blank module file per module in the definition's first stage.
 *
 * With `options.azureDevOps` supplied (`{ organization, project, repository, pat, baseUrl? }`), that data/credential is written to, and that same location is recorded *in*, the created instance.yaml (as `azureDevOps: { organization, project, repository }` — never the `pat`) instead of the local filesystem — see createInstanceInAzureDevOps below. Without it, behavior is byte-for-byte what it was before #85: the three local instances (`examples`, `demo-cli`, `demo-web`) and every existing caller of this function are unaffected, and this call stays synchronous.
 */
export function createInstance(definitionId, slug, options = {}) {
  const definition = loadDefinition(definitionId, { definitionsDir: options.definitionsDir })
  const firstStage = definition.stages[0]
  if (!firstStage) {
    throw new Error(`Definition "${definitionId}" has no stages`)
  }

  if (options.azureDevOps) {
    return createInstanceInAzureDevOps(definitionId, slug, definition, firstStage, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const dir = instanceDir(instancesDir, slug)
  if (storage.exists(dir)) {
    throw new Error(`Instance "${slug}" already exists at ${dir}`)
  }
  storage.ensureDir(join(dir, 'modules'))

  // `assignee` (#97) — the instance record's own single named person, optional and empty by default — is a field on the instance itself, not derived from any module. Distinct from `options.owner` below (unaffected by #97): that seeds each first-stage module file's own frontmatter `owner`, the separate Design Authority sign-off convention docs/adr/0001 and CONTEXT.md describe, which #97 explicitly leaves untouched.
  storage.writeText(
    join(dir, 'instance.yaml'),
    stringifyYAML({ definition: definitionId, slug, stage: firstStage.id, assignee: options.assignee ?? '' })
  )

  for (const moduleId of firstStage.modules) {
    const moduleSpec = definition.modules.get(moduleId)
    storage.writeText(
      modulePath(instancesDir, slug, moduleId),
      renderModuleFile(moduleSpec, { owner: options.owner ?? '' })
    )
  }

  return { slug, definitionId, stage: firstStage.id, modules: firstStage.modules }
}

/**
 * The Azure-DevOps-backed half of createInstance (#85): writes instance.yaml and each first-stage module file to the Azure DevOps repo named by `options.azureDevOps`, reusing `renderModuleFile`/`stringifyYAML` unchanged from the local path above — only *where* the resulting text lands differs. Returns a Promise (a real network call, unlike the local path's plain object return), so callers that pass `options.azureDevOps` must `await` this — callers that don't are untouched by this function existing at all.
 *
 * Each file is a separate Azure DevOps push (there's no multi-file-commit call on this client to batch them into one), so this is not atomic: a failure partway through (a network blip, an expired PAT mid-flow) can leave instance.yaml written with only some of its module files. Rather than surfacing that failure as a bare network error — leaving a caller with a repo in an unexplained partial state, and no way to tell from the error alone what's already there — the module-writing loop below reports exactly which modules were written and which weren't, with a next step (finish the rest via writeModule, since instance.yaml already exists and would make a second createInstance call reject as "already exists").
 */
async function createInstanceInAzureDevOps(definitionId, slug, definition, firstStage, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const { organization, project, repository } = options.azureDevOps
  const location = `${organization}/${project}/${repository}`

  // Belt-and-braces: if the repo disappeared between workspace registration
  // and now (or if checkAzureDevOpsRepo was bypassed), fail with a clear
  // message instead of a raw REST error from the refs endpoint.
  if (!(await client.repoExists())) {
    throw new AzureDevOpsRepoNotFoundError(
      `Azure DevOps repository ${location} does not exist — create it in Azure DevOps first.`
    )
  }

  const alreadyExists = await client
    .getFileContent(azureDevOpsInstancePath(slug), { branch })
    .then(() => true)
    .catch((err) => {
      if (err instanceof AzureDevOpsNotFoundError) return false
      throw err
    })
  if (alreadyExists) {
    throw new Error(`Instance "${slug}" already exists at Azure DevOps ${location}`)
  }

  await client.writeFile(
    azureDevOpsInstancePath(slug),
    stringifyYAML({
      definition: definitionId,
      slug,
      stage: firstStage.id,
      // See createInstance's own comment on `assignee` vs. `options.owner` (#97) — the same explicit, module-independent field, just written to the Azure-DevOps-backed instance.yaml instead of a local one.
      assignee: options.assignee ?? '',
      azureDevOps: { organization, project, repository },
    }),
    { message: `Create instance "${slug}"`, branch }
  )

  const writtenModules = []
  try {
    for (const moduleId of firstStage.modules) {
      const moduleSpec = definition.modules.get(moduleId)
      await client.writeFile(
        azureDevOpsModulePath(slug, moduleId),
        renderModuleFile(moduleSpec, { owner: options.owner ?? '' }),
        { message: `Add module "${moduleId}"`, branch }
      )
      writtenModules.push(moduleId)
    }
  } catch (err) {
    const remaining = firstStage.modules.filter((moduleId) => !writtenModules.includes(moduleId))
    throw new Error(
      `Instance "${slug}" was only partially created at Azure DevOps ${location}: instance.yaml and module(s) ` +
        `${writtenModules.join(', ') || '(none)'} were written, but module "${remaining[0]}" failed (${err.message}). ` +
        `instance.yaml now exists there, so re-running createInstance for this instance will reject as "already ` +
        `exists" — call writeModule directly for the remaining module(s) (${remaining.join(', ')}) to finish it.`
    )
  }

  return { slug, definitionId, stage: firstStage.id, modules: firstStage.modules }
}

// Exported (not just used internally by listInstances below) so lib/instanceRegistry.js's auto-backfill can find every instance actually on disk without re-implementing this same directory-scan-plus-instance.yaml-check — the registry's "any instance.yaml found on disk with no existing registry entry gets one added automatically" behavior (#89) is exactly this same scan.
export function listInstanceSlugs(instancesDir) {
  return storage.listDir(instancesDir).filter((name) => storage.exists(join(instancesDir, name, 'instance.yaml')))
}

/**
 * With `options.azureDevOps` supplied, reads `instance.yaml` from that Azure DevOps repo instead of the local filesystem (see readInstanceFromAzureDevOps below) and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 *
 * `assignee` defaults to `''` when the on-disk instance.yaml predates #97 (every instance created before this ticket, including the examples/demo-cli/demo-web fixtures) — the same "default, not a migration" treatment ADR-0008 gave the instance registry itself.
 */
export function readInstance(slug, options = {}) {
  if (options.azureDevOps) {
    return readInstanceFromAzureDevOps(slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  let text
  try {
    text = storage.readText(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      const available = listInstanceSlugs(instancesDir)
      const hint = available.length ? ` Available instances: ${available.join(', ')}.` : ''
      throw new Error(`No instance "${slug}" at ${path}.${hint}`)
    }
    throw new Error(`Cannot read instance "${slug}" at ${path}: ${err.message}`)
  }
  return withDefaultAssignee(parseYAML(text))
}

/**
 * The Azure-DevOps-backed half of readInstance (#85) — the exact same `parseYAML` call as the local path, over content fetched from Azure DevOps instead of read off disk. There's no "available instances" hint on a miss the way the local path has: `listInstanceSlugs` is a directory scan with no Azure DevOps equivalent in this ticket's scope.
 */
async function readInstanceFromAzureDevOps(slug, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  let text
  try {
    text = await client.getFileContent(azureDevOpsInstancePath(slug), { branch })
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) {
      const { organization, project, repository } = options.azureDevOps
      throw new Error(`No instance "${slug}" at Azure DevOps ${organization}/${project}/${repository}.`)
    }
    throw err
  }
  return withDefaultAssignee(parseYAML(text))
}

/**
 * Updates the instance record's own stored `assignee` (#97) — a single named person, or `''` to clear it — preserving every other field already on `instance.yaml` (`definition`, `slug`, `stage`, and, for an Azure-DevOps-backed instance, its descriptive `azureDevOps` block): this reads the current instance first and only overwrites `assignee` on top of it, rather than reconstructing the file from scratch. Stage transitions never touch this field (there is no code path that changes `stage` at all yet — see #97's own investigation), so an assignee set here stays put across whichever stage the instance is later viewed/moved to.
 *
 * With `options.azureDevOps` supplied, updates `instance.yaml` in that Azure DevOps repo instead of the local filesystem and returns a Promise the caller must `await`. Without it — every existing caller — this stays synchronous.
 */
export function updateInstanceAssignee(slug, assignee, options = {}) {
  if (options.azureDevOps) {
    return updateInstanceAssigneeInAzureDevOps(slug, assignee, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  const current = readInstance(slug, { instancesDir })
  const next = { ...current, assignee }
  storage.writeText(path, stringifyYAML(next))
  return next
}

async function updateInstanceAssigneeInAzureDevOps(slug, assignee, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, assignee }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Update assignee for instance "${slug}"`,
    branch,
  })
  return next
}

/**
 * Updates the instance record's own persisted `requiredReviewer` (#145 Part
 * 2) — the per-instance override for who must review the Pull Request when
 * requesting approval. `null` or `''` clears the override (falling back to
 * the workspace's Owner at request-approval time); a non-empty string is a
 * uniqueName resolved through the identity picker. Read-modify-write, same
 * shape as `updateInstanceAssignee` — preserves every other field on
 * `instance.yaml`.
 */
export function updateInstanceRequiredReviewer(slug, requiredReviewer, options = {}) {
  if (options.azureDevOps) {
    return updateInstanceRequiredReviewerInAzureDevOps(slug, requiredReviewer, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  const current = readInstance(slug, { instancesDir })
  const next = { ...current, requiredReviewer: requiredReviewer || '' }
  storage.writeText(path, stringifyYAML(next))
  return next
}

async function updateInstanceRequiredReviewerInAzureDevOps(slug, requiredReviewer, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, requiredReviewer: requiredReviewer || '' }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Update required reviewer for instance "${slug}"`,
    branch,
  })
  return next
}

/**
 * Writes the instance record's own persisted `stage` pointer — the same field `evaluateStage`/`getStatus`/`checkGate` default to reading when no `stageId`/`gate` is otherwise given. The same read-modify-write shape as `updateInstanceAssignee` above: preserves every other field already on `instance.yaml` (`definition`, `slug`, `assignee`, `workItem`, etc.), rather than reconstructing the file from scratch.
 *
 * Doesn't validate `stageId` against the instance's own definition, or check any gate — that's the caller's job. `lib/stageAdvancement.js`'s `advanceStage` (#115, the local instance "Advance to next stage" self-serve action, ADR-0012) only ever calls this with a stage id it already confirmed is the definition's genuine next stage, once that stage's own gate has genuinely passed; `lib/stageStatus.js`'s `checkStageApprovalStatus` (#125) is its Workspace-backed counterpart's one caller, post-merge.
 *
 * Dual-backend like every other instance.yaml writer: with `options.azureDevOps` supplied, updates `instance.yaml` in that Azure DevOps repo (on `main` — see writeInstanceStageInAzureDevOps below) instead of the local filesystem and returns a Promise the caller must `await`. Without it — the local path every pre-#125 caller uses — this stays synchronous. A Workspace-backed instance never advances via ADR-0012's self-serve route at all: it moves to its next stage only once that stage's own Pull Request is merged (ADR-0014, "PR-based stage approval" — #122-#125's own mechanism), and #125's Check-status action is what performs that advance.
 */
export function writeInstanceStage(slug, stageId, options = {}) {
  if (options.azureDevOps) {
    return writeInstanceStageInAzureDevOps(slug, stageId, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  const current = readInstance(slug, { instancesDir })
  const next = { ...current, stage: stageId }
  storage.writeText(path, stringifyYAML(next))
  return next
}

// The Workspace-backed twin of the local write above (#125): records the
// stage-pointer advance ADR-0014's "Check status" action performs once it
// has itself detected the stage's Pull Request approval and completed
// (merged) that Pull Request — lib/stageStatus.js's checkStageApprovalStatus
// is the one caller. Targets `main` (the client's own default when no
// `branch` is given, and deliberately not a stage branch): main is where the
// just-merged Pull Request put the stage's approved content, so the pointer
// recording "this stage is done, the instance now sits at its next one" is
// an approved outcome of that same merge and belongs beside it — never on a
// WIP stage branch, whose instance.yaml copies stay wherever each one's own
// saves left them.
async function writeInstanceStageInAzureDevOps(slug, stageId, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, stage: stageId }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Advance instance "${slug}" to stage "${stageId}" (Pull Request merged)`,
    branch,
  })
  return next
}

/**
 * Records `workItem` — the Azure DevOps work-item link `lib/workItemLink.js`'s `linkInstanceToWorkItem` (#103) creates — on the instance record: `{ organization, project, workItemType, parentId, baseUrl?, stages: { [stageId]: childWorkItemId } }`. Follows the exact same read-modify-write shape as `instance.yaml`'s own pre-existing descriptive `azureDevOps` field (ADR-0008: "purely descriptive... never reconciled"): every other field already on `instance.yaml` (`definition`, `slug`, `stage`, and, for an Azure-DevOps-backed instance, its own `azureDevOps` block) is preserved untouched. An instance with no `workItem` field is simply unlinked — behaves exactly as it did before this ticket (#103's first acceptance criterion) — so this is never called implicitly, only from an explicit "link this instance" action.
 *
 * With `options.azureDevOps` supplied, updates `instance.yaml` in that Azure DevOps repo instead of the local filesystem and returns a Promise the caller must `await`. Without it — every existing caller — this stays synchronous. Note this `options.azureDevOps` is the instance's own *data* storage location (git-backed), independent of `workItem.organization`/`workItem.project` (the Work Items API's own org/project) — an instance can be locally stored yet linked to a work item in some Azure DevOps project, or Azure-DevOps-backed for its data yet linked to a work item in a different project entirely; this function never assumes the two match.
 */
export function recordInstanceWorkItemLink(slug, workItem, options = {}) {
  if (options.azureDevOps) {
    return recordInstanceWorkItemLinkInAzureDevOps(slug, workItem, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  const current = readInstance(slug, { instancesDir })
  const next = { ...current, workItem }
  storage.writeText(path, stringifyYAML(next))
  return next
}

async function recordInstanceWorkItemLinkInAzureDevOps(slug, workItem, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, workItem }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Link instance "${slug}" to Azure DevOps work item ${workItem.parentId}`,
    branch,
  })
  return next
}

/**
 * Records the Pull Request id ADR-0014's "request approval" action (`lib/stageApproval.js`'s `requestStageApproval`, #124) just opened for `stageId` — keyed by stage, under a new top-level `pullRequests` map (`{ [stageId]: pullRequestId }`), since a Workspace-backed instance routinely has more than one stage's own Pull Request open at once (a later stage's branch stacks on an earlier one that hasn't merged yet, `lib/stageBranch.js`). Follows the exact same read-modify-write shape as `recordInstanceWorkItemLink` above: every other field already on `instance.yaml` is preserved untouched, and this only ever *adds* a stage's entry — `requestStageApproval` itself is what guards against calling this twice for the same stage (throwing before ever reaching this write), not this function.
 *
 * Workspace-backed instances only — `options.azureDevOps` is required, not optional (unlike every other read-modify-write function in this file, which accepts a local-instance path too): a local instance never has a Pull Request to record at all, since ADR-0014's PR-gated approval is exclusively the Workspace-backed mode's own mechanism (a local instance's own stage advancement is the separate, unrelated self-serve write in `lib/stageAdvancement.js`'s `writeInstanceStage`).
 */
export async function recordInstancePullRequest(slug, stageId, pullRequestId, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstancePullRequest is for Workspace-backed instances only — pass options.azureDevOps')
  }
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, pullRequests: { ...(current.pullRequests ?? {}), [stageId]: pullRequestId } }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Request approval for stage "${stageId}" of instance "${slug}" (Pull Request #${pullRequestId})`,
    branch,
  })
  return next
}

// The shared read-modify-write body of recordSyncedFieldOverrides below, over an already-parsed instance record — factored out so both storage backends apply exactly the same merge semantics and can never drift. `updates` may carry `title` and/or `assignee`; a non-empty string sets that stage's override, an explicit empty string *clears* it (reverting the panel to the auto-populated title / inherited instance assignee), and an absent key leaves it untouched. A stage entry left with no overrides at all is removed rather than kept as an empty object.
function applySyncedFieldOverrides(current, stageId, updates) {
  const stages = { ...(current.syncedFields ?? {}) }
  const entry = { ...(stages[stageId] ?? {}) }
  for (const key of ['title', 'assignee']) {
    if (updates[key] === undefined) continue
    if (updates[key] === '') delete entry[key]
    else entry[key] = updates[key]
  }
  if (Object.keys(entry).length === 0) delete stages[stageId]
  else stages[stageId] = entry
  return { ...current, syncedFields: stages }
}

/**
 * Records the current stage's own synced-fields panel overrides (#111) — `{ title?, assignee? }` under a per-stage map on the instance record (`syncedFields: { [stageId]: { title?, assignee? } }`), the same keyed-by-stage shape `pullRequests` already uses. Everything else on `instance.yaml` is preserved untouched (the same read-modify-write shape every other writer in this file follows). An explicit empty string clears that one override — the panel falls back to its default (`"{instance name} — {stage title}"` for the title, the instance's own stored assignee for the assignee) — which is how "overridable" stays reversible; only ever called from an explicit save action on the synced-fields panel, never implicitly.
 *
 * Dual-backend like every other instance.yaml writer: with `options.azureDevOps` supplied, updates `instance.yaml` in that Azure DevOps repo (on whatever branch the caller resolved — lib/server.js's PUT route passes the viewed stage's own branch via resolveStageBranch, matching #122's write convention) instead of the local filesystem and returns a Promise the caller must `await`. Without it — the local path — this stays synchronous.
 */
export function recordSyncedFieldOverrides(slug, stageId, updates, options = {}) {
  if (options.azureDevOps) {
    return recordSyncedFieldOverridesInAzureDevOps(slug, stageId, updates, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  const current = readInstance(slug, { instancesDir })
  const next = applySyncedFieldOverrides(current, stageId, updates)
  storage.writeText(path, stringifyYAML(next))
  return next
}

async function recordSyncedFieldOverridesInAzureDevOps(slug, stageId, updates, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = applySyncedFieldOverrides(current, stageId, updates)
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
    message: `Update synced-field overrides for stage "${stageId}" of instance "${slug}"`,
    branch,
  })
  return next
}

/**
 * `gantry instances`: every instance in `instancesDir`, sorted by slug, with its definition, current stage, and which stages actually have module data on disk — `stage` alone can't tell you that, since it's just a pointer that stays wherever the instance was created, not a claim about which stages have been filled in (e.g. instances/examples/ has real content for every stage, but its recorded `stage` is still "shape"). A lightweight listing distinct from `readInstance`, which returns one instance's full data.
 */
export function listInstances(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  return listInstanceSlugs(instancesDir)
    .sort()
    .map((slug) => {
      const instance = readInstance(slug, { instancesDir })
      const definition = loadDefinition(instance.definition, { definitionsDir })
      const stagesWithData = definition.stages
        .filter((stage) =>
          stage.modules.some((moduleId) => storage.exists(join(instancesDir, slug, 'modules', `${moduleId}.md`)))
        )
        .map((stage) => stage.id)
      return { slug, definition: instance.definition, stage: instance.stage, stagesWithData }
    })
}

// Concurrent readers of the same Azure DevOps repo (evaluateStage's Promise.all over a stage's modules being the everyday case) can each detect the same not-yet-migrated state and race their write-back pushes — and since each push is built on the branch tip it read beforehand, Azure DevOps rejects the loser with TF401028 (HTTP 409). Migrations are rare one-time events per file, so chaining every migration write-back through this single in-process queue costs nothing observable and turns those races into sequential pushes: writeFile re-reads the current tip before each push, so the second one lands cleanly on top of the first's commit. A failing write rejects its own caller as normal without poisoning the chain for whoever queues next.
let migrationWriteQueue = Promise.resolve()
function queueMigrationWrite(write) {
  const run = migrationWriteQueue.catch(() => {}).then(write)
  migrationWriteQueue = run.catch(() => {})
  return run
}

/**
 * Lazily migrates a module file's headings to the new document heading scale (ADR-0016 — module title at `#`, field headings at `##`, author content starting at `###`), following the same "migrate on read, write the result back" pattern ADR-0010 established for the workspace subdirectory layout. Pure text-in/text-out; returns the input unchanged when it's already in the new scale, so callers can detect "a migration happened" by inequality and only then pay for a write-back.
 *
 * An old-scale file is one whose body has no `# <module title>` heading after the frontmatter (the pre-#130 writers never emitted one). Migration then:
 * - inserts `# <moduleSpec.title>` directly after the frontmatter;
 * - keeps every `##` heading that matches a field title where it is (field headings sit at `##` in both scales);
 * - demotes everything else that would collide with the structural scale down so author content starts at `###`: a non-title `#` heading drops two levels, a non-field `##` heading drops one.
 *
 * The last rule is what makes the round-trip lossless: under the old parser a stray `## Not a field` line was an unknown section the parser warned about (or threw on, in strict mode); demoted into the preceding field's content, the author's own heading survives as exactly that — content — instead of masquerading as structure.
 */
export function migrateModuleHeadingScale(text, moduleSpec) {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return text
  const body = text.slice(match[0].length)

  const alreadyMigrated = [...body.matchAll(/^#[ \t]+(.+?)\s*$/gm)].some(
    (heading) => normalizeHeadingText(heading[1]) === moduleSpec.title
  )
  if (alreadyMigrated) return text

  const fieldTitles = new Set(moduleSpec.fields.map((field) => field.title))
  const migratedBody = body
    .split('\n')
    .map((line) => {
      const heading = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line)
      if (!heading) return line
      const level = heading[1].length
      if (level >= 3) return line
      const isModuleTitle = level === 1 && normalizeHeadingText(heading[2]) === moduleSpec.title
      if (isModuleTitle) return line
      const isFieldHeading = level === 2 && fieldTitles.has(normalizeHeadingText(heading[2]))
      if (isFieldHeading) return line
      // Both collision cases land at the same floor: a stray author `#` or `##` becomes a `###`, the level author content starts at.
      return `### ${heading[2]}`
    })
    .join('\n')

  return `${match[0]}# ${moduleSpec.title}\n${migratedBody.replace(/^\r?\n+/, '\n')}`
}

/**
 * Parse a module instance file's frontmatter and field sections into { module, status, owner, fields: { [fieldId]: string | string[] }, warnings }, keyed against `moduleSpec` (from loadDefinition) by matching each `## <field.title>` heading (markdown formatting in the heading is stripped before matching). Fields whose heading isn't found are left out of the result (not defaulted), so callers can distinguish "absent" from "empty".
 *
 * A `##` heading that matches no defined field is a **custom field** (#132) — author-inserted via the editor's Insert ▾ → Section action — not an anomaly: it is parsed and preserved so it survives a save/reload round-trip. Custom sections come back twice over:
 * - `customFields`: `[{ id, title, value }]` in document order, each with a deterministic id (`custom:<slug-of-title>`, `-2`/`-3`… suffixes on collision) so UI lookups and tests have stable handles;
 * - `layout`: the document's full section sequence as `[ { field: '<definedFieldId>' } | { custom: { id, title, value } } ]`, in file order — writeModule replays exactly this sequence, so a custom section inserted between two defined fields stays between them across round-trips.
 *
 * A duplicate heading of a *defined* field (later occurrence wins) is still a warning in `warnings` by default. With `{ strict: true }` — used by `gantry check`'s hard-error path — that condition throws instead, so a gate can't pass on data the parser wasn't confident about. Custom sections never warn and never throw: they are data now, not anomalies (an instance that extends its documents with Insert ▾ → Section must still be able to pass its gates).
 */
export function parseModuleFile(text, moduleSpec, options = {}) {
  const strict = options.strict ?? false
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    throw new Error(`Module file for "${moduleSpec.id}" is missing YAML frontmatter`)
  }
  const frontmatter = parseYAML(match[1]) ?? {}
  const body = text.slice(match[0].length)

  const fieldsById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const warnings = []
  const sections = new Map()
  const layout = []
  const customFields = []
  const usedCustomIds = new Set()
  // `##`-level headings only — never `###` (author content, folded there by migrateModuleHeadingScale on old-scale files). The title part may be EMPTY (`##` or `## `): Insert ▾ → Section lets authors skip the optional title (#132), so an untitled block is still structure to preserve, not noise to skip. Group 2 is undefined for those; callers treat it as ''.
  const headingRe = /^##(?:[ \t]+(.*))?[ \t]*$/gm
  const headings = [...body.matchAll(headingRe)]
  for (let i = 0; i < headings.length; i++) {
    const rawTitle = headings[i][1] ?? ''
    const title = normalizeHeadingText(rawTitle)
    const start = headings[i].index + headings[i][0].length
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length
    const value = body.slice(start, end).trim()

    const fieldDef = [...fieldsById.values()].find((field) => field.title === title)
    if (!fieldDef) {
      // A heading matching no defined field is a preserved custom field (#132), not a warning — see this function's doc comment. Custom sections whose body is entirely bullet items are list-typed fields (#144): they parse as string[] and are replayed as bullets by the writer, matching the defined type:list UI.
      const id = uniqueCustomFieldId(title, usedCustomIds)
      const rawTitleText = rawTitle.trim()
      const isList = isAllBullets(value)
      const custom = isList
        ? { id, title: rawTitleText, type: 'list', value: parseListContent(value) }
        : { id, title: rawTitleText, value }
      customFields.push(custom)
      layout.push({ custom })
      continue
    }
    if (sections.has(title)) {
      const message = `Module "${moduleSpec.id}": duplicate heading "${rawTitle}" — later occurrence wins`
      if (strict) throw new Error(message)
      warnings.push(message)
    }

    sections.set(title, value)
    layout.push({ field: fieldDef.id })
  }

  const fields = {}
  for (const field of moduleSpec.fields) {
    const raw = sections.get(field.title)
    if (raw === undefined) continue
    if (field.type === 'list') {
      // A bullet's wrapped continuation lines (no leading "- ") fold onto the item they follow, rather than being silently dropped.
      const items = []
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim()
        if (line === '') continue
        if (line.startsWith('- ')) {
          items.push(line.slice(2).trim())
        } else if (items.length > 0) {
          items[items.length - 1] += ` ${line}`
        }
      }
      fields[field.id] = items
    } else {
      fields[field.id] = raw
    }
  }

  return {
    module: frontmatter.module,
    status: frontmatter.status,
    owner: frontmatter.owner,
    fields,
    customFields,
    layout,
    warnings,
  }
}

// Tests whether a custom section's body is entirely bullet items (every non-empty line starts with "- "). Used by the parser to classify a custom section as a list field (#144) — mixed content (prose + bullets) stays a plain markdown section. An empty body returns true: a heading-only custom section can be an empty list that was saved before any items were added, and should preserve its list type through the round-trip so the rows UI reappears on reload.
function isAllBullets(body) {
  const lines = body.split('\n').filter((line) => line.trim() !== '')
  return lines.every((line) => line.trim().startsWith('- '))
}

// Parses a bullet-list body into an array of trimmed strings. Every "- " prefix is stripped; continuation lines (no "- " prefix) fold onto the preceding item, matching the defined-type:list parser's own behaviour.
function parseListContent(body) {
  const items = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('- ')) {
      items.push(line.slice(2).trim())
    } else if (items.length > 0) {
      items[items.length - 1] += ` ${line}`
    }
  }
  return items
}

// Deterministic id for a parsed custom field: `custom:` + a slug of its title, disambiguated with -2/-3… on any collision (including different titles that slug identically). Deterministic (not random) so the same file always parses to the same ids — the UI keys components off these ids, and re-reading an unchanged file must never churn them. `usedIds` accumulates across the whole module being parsed.
function uniqueCustomFieldId(title, usedIds) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  let candidate = `custom:${slug}`
  let n = 2
  while (usedIds.has(candidate)) {
    candidate = `custom:${slug}-${n}`
    n++
  }
  usedIds.add(candidate)
  return candidate
}

/**
 * Writes a module instance file in the same format `createInstance`/`parseModuleFile` produce and read: frontmatter (`module`, `status`, `owner`) followed by one `## <title>` section per field, in `moduleSpec` order — or, when `data.layout` is supplied (the editor's save payload), in exactly that document order, including preserved custom-field sections (`{ custom: { id, title, value } }` entries, #132). `data.fields` is keyed by field id, as returned by `parseModuleFile`/`readModule` — this is the exact inverse of those.
 *
 * With `options.azureDevOps` supplied, writes the module file to that Azure DevOps repo instead of the local filesystem and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem write it always was; the frontmatter/section text itself is built by `renderModuleInstanceFile` either way, so the two storage backends can never drift in what they write.
 */
export function writeModule(definition, slug, moduleId, data, options = {}) {
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }

  const text = renderModuleInstanceFile(moduleId, moduleSpec, data)

  if (options.azureDevOps) {
    return writeModuleToAzureDevOps(slug, moduleId, text, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = modulePath(instancesDir, slug, moduleId)
  storage.writeText(path, text)
  return { module: moduleId, path }
}

// The exact frontmatter+field-sections text writeModule writes and readModule/parseModuleFile read back — factored out of writeModule so both storage backends write the identical bytes, computed exactly once per call, rather than each backend recomputing (and risking drifting) its own copy.
//
// When `data.layout` is present (parseModuleFile always produces one; the editor replays it back on save), the section sequence is replayed exactly as parsed/sent — defined fields and preserved custom fields (#132) in document order, so a custom section inserted between two defined fields stays between them across save/reload. Defined fields absent from the layout are still emitted, appended after it in definition order: every reader expects each defined field's heading to exist, even a blank one. Without a layout — every pre-#132 caller — the output is byte-for-byte what it always was.
function renderModuleInstanceFile(moduleId, moduleSpec, data) {
  const frontmatter = stringifyYAML({
    module: moduleId,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
  }).trimEnd()

  const fieldsById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const sectionText = (title, body) => `## ${title}\n\n${body}\n`
  const definedFieldBody = (field) => {
    const value = data.fields?.[field.id]
    return field.type === 'list'
      ? (Array.isArray(value) ? value : [])
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .map((item) => `- ${item}`)
          .join('\n')
      : value ?? ''
  }

  const sections = []
  const laidOut = new Set()
  for (const entry of data.layout ?? []) {
    if (entry.field !== undefined) {
      const field = fieldsById.get(entry.field)
      if (!field) continue
      sections.push(sectionText(field.title, definedFieldBody(field)))
      laidOut.add(field.id)
    } else if (entry.custom) {
      const body =
        entry.custom.type === 'list'
          ? (Array.isArray(entry.custom.value) ? entry.custom.value : [])
              .map((item) => item.trim())
              .filter((item) => item !== '')
              .map((item) => `- ${item}`)
              .join('\n')
          : entry.custom.value ?? ''
      sections.push(sectionText(entry.custom.title ?? '', body))
    }
  }
  for (const field of moduleSpec.fields) {
    if (!laidOut.has(field.id)) {
      sections.push(sectionText(field.title, definedFieldBody(field)))
    }
  }

  // New document heading scale (ADR-0016): module title at `#`, field headings at `##` — the same shape renderModuleFile seeds new instances with, so a saved file and a freshly created one can't drift.
  return `---\n${frontmatter}\n---\n\n# ${moduleSpec.title}\n\n${sections.join('\n')}`
}

async function writeModuleToAzureDevOps(slug, moduleId, text, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const path = azureDevOpsModulePath(slug, moduleId)
  await client.writeFile(path, text, { message: `Update module "${moduleId}"`, branch })
  return { module: moduleId, path }
}

/**
 * With `options.azureDevOps` supplied, reads the module file from that Azure DevOps repo instead of the local filesystem and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 *
 * `options.strict` is forwarded to `parseModuleFile` on both paths — a parser anomaly (a duplicate defined-field heading) throws instead of warning, matching `evaluateStage`'s (`lib/status.js`) `check`-mode contract regardless of which storage backend a module is read from. Custom-field sections (#132) are never an anomaly on either path — they are preserved data, not parser doubt.
 */
export function readModule(definition, slug, moduleId, options = {}) {
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }
  const strict = options.strict ?? false

  if (options.azureDevOps) {
    return readModuleFromAzureDevOps(moduleSpec, slug, moduleId, options, strict)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = modulePath(instancesDir, slug, moduleId)
  let text
  try {
    text = storage.readText(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Module "${moduleId}" has no saved data for instance "${slug}" (expected ${path}) — fill in its fields and save before rendering`
      )
    }
    throw new Error(`Cannot read module "${moduleId}" for instance "${slug}" at ${path}: ${err.message}`)
  }
  // Lazy heading-scale migration (ADR-0016): an old-scale file is bumped to the new scale and written straight back, so the next read — and every other reader — sees new-scale bytes without any manual step.
  const migrated = migrateModuleHeadingScale(text, moduleSpec)
  if (migrated !== text) {
    storage.writeText(path, migrated)
  }
  return parseModuleFile(migrated, moduleSpec, { strict })
}

// The Azure-DevOps-backed half of readModule (#85) — the exact same parseModuleFile call as the local path, over content fetched from Azure DevOps instead of read off disk.
async function readModuleFromAzureDevOps(moduleSpec, slug, moduleId, options, strict) {
  const { client, branch } = azureDevOpsClientFor(options)
  const path = azureDevOpsModulePath(slug, moduleId)
  let text
  try {
    text = await client.getFileContent(path, { branch })
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) {
      throw new Error(
        `Module "${moduleId}" has no saved data for instance "${slug}" (expected ${path} in Azure DevOps) — fill in its fields and save before rendering`
      )
    }
    throw err
  }
  // The same lazy heading-scale migration as the local path above (ADR-0016), pushed back as its own commit so the remote repo's file is new-scale too — queued behind any other in-flight migration push so concurrent readers can't race each other's commits (see queueMigrationWrite).
  const migrated = migrateModuleHeadingScale(text, moduleSpec)
  if (migrated !== text) {
    await queueMigrationWrite(() =>
      client.writeFile(path, migrated, {
        message: `Migrate module "${moduleId}" headings to the # / ## scale (ADR-0016)`,
        branch,
      })
    )
  }
  return parseModuleFile(migrated, moduleSpec, { strict })
}
