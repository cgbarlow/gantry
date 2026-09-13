import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { loadDefinition, getLatestPublishedVersion, listVersionNumbers } from './definition.js'
import { localFilesystemStorage as storage } from './storage.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsRepoNotFoundError } from './azureDevOpsClient.js'
import { isValidSlug } from './slug.js'

export function instanceDefinitionVersion(instance) {
  return instance?.definitionVersion ?? 1
}

export function loadDefinitionForInstance(instance, options = {}) {
  const version = instanceDefinitionVersion(instance)
  return loadDefinition(instance.definition, { ...options, version })
}

function resolvePinnedVersion(definitionId, options = {}) {
  if (options.definitionVersion !== undefined && options.definitionVersion !== null) {
    return Number(options.definitionVersion)
  }
  if (options.version !== undefined && options.version !== null) {
    return Number(options.version)
  }
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const versions = listVersionNumbers(definitionId, definitionsDir)
  if (versions.length > 0) {
    const latest = getLatestPublishedVersion(definitionId, definitionsDir)
    if (latest !== null) return latest
    // No published version: fall back to highest version for creation? caller will error if draft not allowed without confirmation
    return Math.max(...versions)
  }
  return 1
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const reviewWriteLocks = new Map()

async function withReviewWriteLock(slug, operation) {
  const previous = reviewWriteLocks.get(slug) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  reviewWriteLocks.set(slug, current)
  try {
    return await current
  } finally {
    if (reviewWriteLocks.get(slug) === current) reviewWriteLocks.delete(slug)
  }
}

// --- Canonical instance.yaml serialization (#201) --------------------------
//
// Every `record*`/`write*`/`update*` function above eventually does the same
// thing: read the current instance record, spread a changed field or two on
// top of it (`{ ...current, field: value }`), and serialize the *whole*
// object fresh via `stringifyYAML`. `yaml`'s serializer emits keys in
// whatever order the JS object happens to hold them in — which, for a
// plain-object spread, is insertion order: the order keys were first added
// across however many read-modify-write calls built up this particular
// in-memory object. Two independent writers (e.g. two stacked stage
// branches, `lib/stageBranch.js`, each with their own long-lived copy of
// `instance.yaml`) that each add a *different* new key — one adds
// `pullRequests.hld-define`, the other advances `stage` — end up with
// different key orders even though neither touched a field the other cares
// about. Git's line-based 3-way merge sees that as the whole document having
// moved, not two disjoint edits, and reports a conflict that has nothing to
// do with any real value disagreement (confirmed live: `mergeStatus: 2` on a
// stacked-stage PR from exactly this).
//
// The fix is to make serialization canonical: route every instance.yaml
// write through `stringifyInstanceYAML` below instead of calling
// `stringifyYAML` directly on a freshly-spread object. It recursively sorts
// every plain object's keys alphabetically — both the fixed top-level
// schema (`assignee`, `azureDevOps`, `definition`, ...) and every
// dynamic/id-keyed map instance.yaml holds (`pullRequests`, `approvalStates`,
// `syncedFields`, and `workItem.stages`) — so the emitted key order depends
// only on the *set* of keys present, never on the order they were added in.
// Two writers touching disjoint fields then produce identical bytes for
// every field neither of them changed, which is exactly what git's 3-way
// merge needs to resolve the two independent hunks cleanly and leave a real
// conflict (the same field set to two different values on both sides) as
// the only kind of conflict that can still occur.
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

// The single shared serialization helper every instance.yaml writer in this
// file routes through — see the comment above. Never call `stringifyYAML`
// directly on an instance record; always go through this.
function stringifyInstanceYAML(record) {
  return stringifyYAML(canonicalizeForSerialization(record))
}

// Unresolved git merge-conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) left
// in a fetched instance.yaml are the one case canonical serialization can't
// prevent: a genuine semantic conflict, where both sides of a merge set the
// *same* field to two different real values. Left undetected, that text
// either fails to parse as YAML with a cryptic error, or — worse, if the
// markers happen to sit somewhere YAML tolerates as a scalar — parses
// "successfully" into garbage data. Checking for the markers explicitly, and
// naming the conflicting stage id(s) when the shape lets us, turns that into
// a clear, actionable error instead of an opaque failure surfacing from deep
// inside whatever the caller does with the corrupted result.
const MERGE_CONFLICT_MARKER_RE = /^<{7}(?: |$)|^={7}$|^>{7}(?: |$)/m

function assertNoMergeConflictMarkers(text, { slug, source }) {
  if (!MERGE_CONFLICT_MARKER_RE.test(text)) return
  const stageMatches = [...text.matchAll(/^\s*([\w.-]+):\s*(?:\S.*)?$/gm)]
    .map((match) => match[1])
    .filter((key) => !['definition', 'slug', 'stage', 'assignee', 'requiredReviewer', 'azureDevOps', 'workItem'].includes(key))
  const hint = stageMatches.length ? ` Fields near the conflict include: ${[...new Set(stageMatches)].join(', ')}.` : ''
  throw new Error(
    `instance.yaml for instance "${slug}" (${source}) has an unresolved git merge conflict — both sides of a merge ` +
      `set the same field to genuinely different values, so it could not be resolved automatically.${hint} Resolve ` +
      'it by hand (pick or combine the two sides\' values for the conflicting field, removing the <<<<<<< / ======= ' +
      '/ >>>>>>> marker lines) and commit the result before retrying.'
  )
}

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

// Small known-acronym set (WI226) — words a title-cased slug should render
// fully upper-cased even though they're longer than the "short word" cutoff
// below (or, for the short ones, kept here for intent/clarity). Just enough
// to turn `atlas-reference-design` into `ATLAS Reference Design`.
const KNOWN_SLUG_ACRONYMS = new Set(['atlas', 'hld', 'sad', 'ssad', 'soap', 'nfr', 'api', 'db'])

// Title-cases a slug for display when instance.yaml carries no explicit
// `name:` (WI226). Split on `-`; each word is upper-cased entirely when it's
// ≤4 chars or a known acronym, otherwise just its first letter is capitalised.
export function titleCaseSlug(slug) {
  return String(slug ?? '')
    .split('-')
    .filter(Boolean)
    .map((word) =>
      word.length <= 4 || KNOWN_SLUG_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ')
}

// The instance's human-facing display name (WI226): its optional `name:`
// field verbatim when set, otherwise a title-cased form of its slug.
export function instanceDisplayName(instance) {
  const name = typeof instance?.name === 'string' ? instance.name.trim() : ''
  return name || titleCaseSlug(instance?.slug)
}

// Filesystem- and path-safe: replace `/ \ : * ? " < > |` with `-`, collapse
// runs of `-` or whitespace, trim leading/trailing separators (WI226).
export function sanitiseRenderFilename(text) {
  return String(text ?? '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '')
}

// The basename (no extension) every rendered artefact is written under
// locally and pushed to Azure DevOps as (WI226):
//   "<Instance name> - <Full artefact title>"
// e.g. "ATLAS Reference Design - High Level Design".
export function renderedArtefactBasename(instanceName, artefactTitle) {
  return sanitiseRenderFilename(`${instanceName} - ${artefactTitle}`)
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

// WI226: the pushed `.docx` is now named "<Instance name> - <Full artefact
// title>.docx", not "<artefactId>.docx" — so this takes the instance's
// display name and the artefact's full title instead of its id.
// `extension` (WI #359): defaults to `'docx'`, matching every caller that predates the
// render-dialog format toggle — pass `'md'` for a markdown-only render's push path.
export function azureDevOpsOutPath(slug, instanceName, artefactTitle, extension = 'docx') {
  assertValidAzureDevOpsSlug(slug)
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/out/${renderedArtefactBasename(instanceName, artefactTitle)}.${extension}`
}

// WI260 — repo-as-asset-store: `gantry-workspace/<slug>/assets/<name>` is the instance's asset dir, sibling of `modules/` and `out/`. See README's Repository layout and lib/assets.js for the convention. This is the repo-relative path for one asset file or the assets dir itself.
export function azureDevOpsAssetsDir(slug) {
  assertValidAzureDevOpsSlug(slug)
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets`
}

export function azureDevOpsAssetPath(slug, filename) {
  assertValidAzureDevOpsSlug(slug)
  // `filename` is a single path segment (no slashes) validated at the HTTP layer; keep it verbatim so listing and file-fetch agree on the same path.
  return `${azureDevOpsAssetsDir(slug)}/${filename}`
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

// WI288: the repo-root `README.md` written the first time a workspace-backed
// instance is created into an Azure DevOps repo that has none yet. It keeps the
// standard Azure DevOps README template's four headings verbatim (`# Introduction`,
// `# Getting Started`, `# Build and Test`, `# Contribute`) so it reads as the
// familiar template, but every section is filled in with real content about this
// gantry workspace — no `TODO:` placeholders. A workspace repo hosts many
// instances, so `createInstanceInAzureDevOps` only calls this when the repo root
// has no README, leaving the first instance's README untouched for the 2nd+.
function renderWorkspaceReadme({ slug, displayTitle, definitionTitle, definitionDescription }) {
  const description = String(definitionDescription ?? '').replace(/\s+/g, ' ').trim()
  return `# Introduction

This repository is a **gantry workspace**. It holds the design and process content for **${displayTitle}** (\`${slug}\`) — an instance of the **${definitionTitle}** definition: ${description}

Content is authored through gantry, not by hand-editing this repo. Each instance lives under \`gantry-workspace/<slug>/\` — \`instance.yaml\`, \`modules/*.md\`, rendered \`out/*.docx\`, and \`assets/\`.

# Getting Started

1. Install gantry and run \`gantry serve\` (see the gantry project README).
2. Open the instance in your browser and authenticate with your own Azure DevOps personal access token when prompted — it is held per-browser and never stored on the server.
3. Edit module content in the editor. Work for an in-progress stage lives on a stage branch (\`gantry-workspace/<slug>/<stageId>\`); \`main\` holds signed-off content.

# Build and Test

- Rendered documents are produced by the **Render** action in the editor, or \`gantry render <slug> <artefact>\`; output lands in \`gantry-workspace/<slug>/out/\`.
- The process is staged and gated: each stage has a gate that must pass before sign-off, and sign-off is a pull request from the stage branch into \`main\`.

# Contribute

Edit through gantry. Do not hand-edit \`modules/*.md\` or \`instance.yaml\` directly — gantry manages the branch/PR flow and canonical serialisation. Process or template changes belong in the gantry definition, not this repo.
`
}

/**
 * `gantry new <definitionId> <slug>`: creates instances/<slug>/instance.yaml plus one blank module file per module in the definition's first stage.
 *
 * With `options.azureDevOps` supplied (`{ organization, project, repository, pat, baseUrl? }`), that data/credential is written to, and that same location is recorded *in*, the created instance.yaml (as `azureDevOps: { organization, project, repository }` — never the `pat`) instead of the local filesystem — see createInstanceInAzureDevOps below. Without it, behavior is byte-for-byte what it was before #85: the three local instances (`examples`, `demo-cli`, `demo-web`) and every existing caller of this function are unaffected, and this call stays synchronous.
 */
export function createInstance(definitionId, slug, options = {}) {
  const pinnedVersion = resolvePinnedVersion(definitionId, options)
  const definition = loadDefinition(definitionId, { definitionsDir: options.definitionsDir, version: pinnedVersion })
  const firstStage = definition.stages[0]
  if (!firstStage) {
    throw new Error(`Definition "${definitionId}" has no stages`)
  }

  if (options.azureDevOps) {
    return createInstanceInAzureDevOps(definitionId, slug, definition, firstStage, { ...options, definitionVersion: pinnedVersion })
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
    stringifyInstanceYAML({ definition: definitionId, slug, stage: firstStage.id, assignee: options.assignee ?? '', definitionVersion: pinnedVersion })
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

// WI288: seed a filled-in repo-root README.md the first time an instance is
// created into this workspace repo — but never overwrite one that is already
// there (a workspace hosts many instances; the 2nd+ must leave the 1st's
// README untouched). Best-effort, in the same spirit as the module-writing
// loops below: instance.yaml has already been committed at this point, so a
// README read/write failure is logged and skipped rather than failing the
// caller's own instance creation/import. Shared by createInstanceInAzureDevOps
// (blank instance) and importInstanceToAzureDevOps (WI #305, real imported
// content) — both write the exact same first-instance README either way.
async function ensureWorkspaceReadme(client, branch, { slug, displayTitle, definitionTitle, definitionDescription, location }) {
  try {
    const readmeExists = await client
      .getFileContent('README.md', { branch })
      .then(() => true)
      .catch((err) => {
        if (err instanceof AzureDevOpsNotFoundError) return false
        throw err
      })
    if (!readmeExists) {
      await client.writeFile(
        'README.md',
        renderWorkspaceReadme({ slug, displayTitle, definitionTitle, definitionDescription }),
        { message: `Add workspace README for instance "${slug}"`, branch }
      )
    }
  } catch (err) {
    console.error(
      `lib/instance.js: could not write repo-root README.md for workspace instance "${slug}" at Azure DevOps ${location} — ${err.message}`
    )
  }
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

  const pinnedVersionForAdo = options.definitionVersion ?? resolvePinnedVersion(definitionId, options)
  await client.writeFile(
    azureDevOpsInstancePath(slug),
    stringifyInstanceYAML({
      definition: definitionId,
      slug,
      stage: firstStage.id,
      // See createInstance's own comment on `assignee` vs. `options.owner` (#97) — the same explicit, module-independent field, just written to the Azure-DevOps-backed instance.yaml instead of a local one.
      assignee: options.assignee ?? '',
      definitionVersion: pinnedVersionForAdo,
      azureDevOps: { organization, project, repository },
    }),
    { message: `Create instance "${slug}"`, branch }
  )

  await ensureWorkspaceReadme(client, branch, {
    slug,
    displayTitle: instanceDisplayName({ name: options.name, slug }),
    definitionTitle: definition.title,
    definitionDescription: definition.description,
    location,
  })

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

/**
 * WI #305 — imports a local-workspace instance's *real* content into the Azure DevOps repo named by `options.azureDevOps`, rather than createInstanceInAzureDevOps's blank first-stage template: `instance.yaml` carries the caller-supplied `stage`/`assignee`/`definitionVersion` (the imported instance's own values, not necessarily the definition's first stage), and every entry in `options.modules` (`[{ id, text }]`, already-rendered module-file text read verbatim off the source local instance's `modules/*.md` files) and `options.assets` (`[{ filename, base64 }]`, off `assets/*`) is written unchanged — `out/` is never part of either array, by construction of the caller (web/pages/new-workspace-wizard.js never reads it off the local instance in the first place). Reuses the exact same repo-existence guard, "instance.yaml already exists at this slug" 409-mapped rejection, and best-effort first-instance README as createInstanceInAzureDevOps, so a slug collision at the destination is rejected identically to a blank create.
 *
 * `stage` is trusted from the caller (the source instance's own `instance.yaml`) but still checked against the destination definition's real stage ids — an imported instance referencing a stage id the destination definition doesn't have (e.g. imported against a different definition/version than it was authored under) falls back to the definition's first stage rather than writing an unresolvable pointer.
 *
 * Like createInstanceInAzureDevOps, not atomic — each file is its own Azure DevOps push. A failure partway through the module or asset loop reports exactly what was written before the failure, in the same spirit as createInstanceInAzureDevOps's own partial-failure message.
 */
export async function importInstanceToAzureDevOps(definitionId, slug, options = {}) {
  const pinnedVersion = resolvePinnedVersion(definitionId, options)
  const definition = loadDefinition(definitionId, { definitionsDir: options.definitionsDir, version: pinnedVersion })
  const firstStage = definition.stages[0]
  if (!firstStage) {
    throw new Error(`Definition "${definitionId}" has no stages`)
  }
  const stageId = definition.stages.some((s) => s.id === options.stage) ? options.stage : firstStage.id

  const { client, branch } = azureDevOpsClientFor(options)
  const { organization, project, repository } = options.azureDevOps
  const location = `${organization}/${project}/${repository}`

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
    stringifyInstanceYAML({
      definition: definitionId,
      slug,
      stage: stageId,
      assignee: options.assignee ?? '',
      definitionVersion: pinnedVersion,
      azureDevOps: { organization, project, repository },
    }),
    { message: `Import instance "${slug}" from local workspace`, branch }
  )

  await ensureWorkspaceReadme(client, branch, {
    slug,
    displayTitle: instanceDisplayName({ name: options.name, slug }),
    definitionTitle: definition.title,
    definitionDescription: definition.description,
    location,
  })

  const writtenModules = []
  try {
    for (const mod of options.modules ?? []) {
      await client.writeFile(azureDevOpsModulePath(slug, mod.id), mod.text, {
        message: `Import module "${mod.id}"`,
        branch,
      })
      writtenModules.push(mod.id)
    }
  } catch (err) {
    throw new Error(
      `Instance "${slug}" was only partially imported at Azure DevOps ${location}: instance.yaml and module(s) ` +
        `${writtenModules.join(', ') || '(none)'} were written, but importing the remaining module(s) failed ` +
        `(${err.message}). instance.yaml now exists there, so re-running the import will reject as "already exists".`
    )
  }

  const writtenAssets = []
  try {
    for (const asset of options.assets ?? []) {
      await client.writeFile(azureDevOpsAssetPath(slug, asset.filename), asset.base64 ?? '', {
        message: `Import asset "${asset.filename}"`,
        branch,
        contentType: 'base64encoded',
      })
      writtenAssets.push(asset.filename)
    }
  } catch (err) {
    throw new Error(
      `Instance "${slug}" was only partially imported at Azure DevOps ${location}: instance.yaml, module(s) ` +
        `${writtenModules.join(', ') || '(none)'} and asset(s) ${writtenAssets.join(', ') || '(none)'} were ` +
        `written, but importing the remaining asset(s) failed (${err.message}). instance.yaml now exists there, ` +
        `so re-running the import will reject as "already exists".`
    )
  }

  return { slug, definitionId, stage: stageId, modules: writtenModules, assets: writtenAssets }
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
  assertNoMergeConflictMarkers(text, { slug, source: path })
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
  assertNoMergeConflictMarkers(text, { slug, source: `Azure DevOps${options.azureDevOps.branch ? ` branch "${options.azureDevOps.branch}"` : ''}` })
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
  storage.writeText(path, stringifyInstanceYAML(next))
  return next
}

async function updateInstanceAssigneeInAzureDevOps(slug, assignee, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, assignee }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
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
  storage.writeText(path, stringifyInstanceYAML(next))
  return next
}

async function updateInstanceRequiredReviewerInAzureDevOps(slug, requiredReviewer, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, requiredReviewer: requiredReviewer || '' }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
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
  storage.writeText(path, stringifyInstanceYAML(next))
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
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
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
  storage.writeText(path, stringifyInstanceYAML(next))
  return next
}

async function recordInstanceWorkItemLinkInAzureDevOps(slug, workItem, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = { ...current, workItem }
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message: `Link instance "${slug}" to Azure DevOps work item ${workItem.parentId}`,
    branch,
  })
  return next
}

function applyPullRequestStatus(record, stageId, status) {
  if (status === undefined) return record
  const pullRequestStatuses = { ...(record.pullRequestStatuses ?? {}) }

  if (status === null) delete pullRequestStatuses[stageId]
  else pullRequestStatuses[stageId] = status

  const next = { ...record }
  if (Object.keys(pullRequestStatuses).length === 0) delete next.pullRequestStatuses
  else next.pullRequestStatuses = pullRequestStatuses

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
  const next = applyPullRequestStatus(
    { ...current, pullRequests: { ...(current.pullRequests ?? {}), [stageId]: pullRequestId } },
    stageId,
    options.pullRequestStatus,
  )
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message: `Request approval for stage "${stageId}" of instance "${slug}" (Pull Request #${pullRequestId})`,
    branch,
  })
  return next
}

/**
 * Persists the last-known status of a stage's Pull Request alongside its id.
 * Workspace-backed instances only; a local instance never has a Pull Request.
 *
 * `status` is required — pass `null` to remove the entry if a later reset is
 * needed (e.g. a re-request). Writes are skipped when the status is unchanged
 * to avoid unnecessary commits when Check is re-run without state movement.
 */
export async function recordInstancePullRequestStatus(slug, stageId, status, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstancePullRequestStatus is for Workspace-backed instances only — pass options.azureDevOps')
  }
  if (status === undefined) {
    throw new Error('recordInstancePullRequestStatus requires a status')
  }

  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  if (current.pullRequestStatuses?.[stageId] === status) return current

  const next = applyPullRequestStatus(current, stageId, status)
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message:
      status === null
        ? `Clear Pull Request status for stage "${stageId}" of instance "${slug}"`
        : `Record Pull Request status for stage "${stageId}" of instance "${slug}" (${status})`,
    branch,
  })
  return next
}

/**
 * Records one independently tracked review request for a Workspace-backed
 * stage. Review requests are arrays keyed by stage because a stage can have
 * several reviewers while keeping review history isolated between stages.
 */
export async function recordInstanceReviewRequest(slug, stageId, review, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstanceReviewRequest is for Workspace-backed instances only — pass options.azureDevOps')
  }
  return withReviewWriteLock(slug, async () => {
    const { client, branch } = azureDevOpsClientFor(options)
    const current = await readInstanceFromAzureDevOps(slug, options)
    const reviewRequests = { ...(current.reviewRequests ?? {}) }
    reviewRequests[stageId] = [...(reviewRequests[stageId] ?? []), review]
    const next = { ...current, reviewRequests }
    await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
      message: `Request review for stage "${stageId}" of instance "${slug}" (work item #${review.workItemId})`,
      branch,
    })
    return next
  })
}

/**
 * Updates the cached native Azure DevOps state for one review request. The
 * state is intentionally persisted only after an explicit status check; a
 * page load never polls review work items.
 */
export async function recordInstanceReviewStatus(slug, stageId, workItemId, status, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstanceReviewStatus is for Workspace-backed instances only — pass options.azureDevOps')
  }
  return withReviewWriteLock(slug, async () => {
    const { client, branch } = azureDevOpsClientFor(options)
    const current = await readInstanceFromAzureDevOps(slug, options)
    const reviewRequests = { ...(current.reviewRequests ?? {}) }
    const reviews = reviewRequests[stageId] ?? []
    const index = reviews.findIndex((review) => Number(review.workItemId) === Number(workItemId))
    if (index === -1) {
      throw new Error(`Instance "${slug}" has no review request for work item #${workItemId} on stage "${stageId}"`)
    }
    reviewRequests[stageId] = reviews.map((review, reviewIndex) =>
      reviewIndex === index ? { ...review, status } : review
    )
    const next = { ...current, reviewRequests }
    await client.writeFile(azureDevOpsInstancePath(slug), stringifyYAML(next), {
      message: `Update review status for stage "${stageId}" of instance "${slug}" (work item #${workItemId})`,
      branch,
    })
    return next
  })
}

/**
 * Persists the approval lifecycle for a stage. The invalidated record keeps
 * the reviewer and commit timestamps that caused the stale approval so the
 * state survives reloads and can be resolved by a later "Request approval
 * again" action. Passing null removes the stage's state after a reset.
 */
export async function recordInstanceApprovalState(slug, stageId, state, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstanceApprovalState is for Workspace-backed instances only — pass options.azureDevOps')
  }
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const approvalStates = { ...(current.approvalStates ?? {}) }
  if (state === null) delete approvalStates[stageId]
  else approvalStates[stageId] = state

  const next = { ...current }
  if (Object.keys(approvalStates).length) next.approvalStates = approvalStates
  else delete next.approvalStates

  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message:
      state === null
        ? `Clear invalidated approval for stage "${stageId}" of instance "${slug}"`
        : `Invalidate approval for stage "${stageId}" of instance "${slug}"`,
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
  storage.writeText(path, stringifyInstanceYAML(next))
  return next
}

async function recordSyncedFieldOverridesInAzureDevOps(slug, stageId, updates, options) {
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = applySyncedFieldOverrides(current, stageId, updates)
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message: `Update synced-field overrides for stage "${stageId}" of instance "${slug}"`,
    branch,
  })
  return next
}

// --- Re-open a signed-off stage (WI265, docs/adr/0026) --------------------
function applyReopened(current, stageId, previousStage) {
  const reopened = { ...(current.reopened ?? {}) }
  reopened[stageId] = { at: new Date().toISOString(), previousStage }
  return { ...current, stage: stageId, reopened }
}

function applyClearReopened(current, stageId) {
  if (!current.reopened?.[stageId]) return current
  const reopened = { ...current.reopened }
  delete reopened[stageId]
  const next = { ...current }
  if (Object.keys(reopened).length) next.reopened = reopened
  else delete next.reopened
  return next
}

export async function recordInstanceReopened(slug, stageId, previousStage, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('recordInstanceReopened is for Workspace-backed instances only — pass options.azureDevOps')
  }
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  const next = applyReopened(current, stageId, previousStage)
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message: `Re-open stage "${stageId}" of instance "${slug}" (was at "${previousStage}")`,
    branch,
  })
  return next
}

export async function clearInstanceReopened(slug, stageId, options = {}) {
  if (!options.azureDevOps) {
    throw new Error('clearInstanceReopened is for Workspace-backed instances only — pass options.azureDevOps')
  }
  const { client, branch } = azureDevOpsClientFor(options)
  const current = await readInstanceFromAzureDevOps(slug, options)
  if (!current.reopened?.[stageId]) return current
  const next = applyClearReopened(current, stageId)
  await client.writeFile(azureDevOpsInstancePath(slug), stringifyInstanceYAML(next), {
    message: `Clear re-opened marker for stage "${stageId}" of instance "${slug}"`,
    branch,
  })
  return next
}

/**
 * `gantry instances`: every instance in `instancesDir`, sorted by slug, with its definition, current stage, and which stages actually have module data on disk — `stage` alone can't tell you that, since it's just a pointer that stays wherever the instance was created, not a claim about which stages have been filled in (e.g. the bundled Kiwi Cover Mutual instance has real content for every stage, but its recorded `stage` is still "shape"). A lightweight listing distinct from `readInstance`, which returns one instance's full data.
 */
export function listInstances(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  return listInstanceSlugs(instancesDir)
    .sort()
    .map((slug) => describeInstance(slug, options))
}

/**
 * One instance's listing row — the body `listInstances` above maps over, split out (WI #370) so a
 * caller that has already worked out *which* directory a given slug lives in can build the same row
 * without re-scanning a directory to rediscover it. `lib/instanceDataDir.js`'s `listWorkspaceInstances`
 * is that caller: under the two-level workspaces layout each instance's `instancesDir` differs row by
 * row, so there is no single directory for `listInstanceSlugs` to scan.
 *
 * Behaviourally identical to what `listInstances` always did per slug — same fields, same
 * `stagesWithData` derivation — and `listInstances` itself now goes through here, so the two can't drift.
 */
export function describeInstance(slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinitionForInstance(instance, { definitionsDir })
  const stagesWithData = definition.stages
    .filter((stage, stageIndex) => {
      // A shared module is attributed to the first stage that mounts it;
      // the blank Shape copy of `dependencies` must not imply that later
      // Detailed Design work has started.
      const earlierModules = new Set(definition.stages.slice(0, stageIndex).flatMap((earlier) => earlier.modules))
      return stage.modules.some(
        (moduleId) =>
          !earlierModules.has(moduleId) && storage.exists(join(instancesDir, slug, 'modules', `${moduleId}.md`))
      )
    })
    .map((stage) => stage.id)
  return { slug, definition: instance.definition, stage: instance.stage, stagesWithData }
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
      // WI 149: an emptied custom list (zero items left after a removal) should remove the whole segment including its heading — reversing the previous preserve-when-empty behaviour for custom-inserted lists only. Schema-defined type:list fields (entry.field path above) keep their heading even when empty.
      if (entry.custom.type === 'list' && body === '') continue
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

/**
 * Writes several modules at once — the stage-level Save (WI #376). `modules` maps module id to the same `{ status, owner, fields, layout }` payload `writeModule` takes. Every module id is checked before anything is written, so an unknown id writes nothing.
 *
 * With `options.azureDevOps`, every file goes into one commit in one push (`options.message` names it) and a Promise is returned; that push is all or nothing. Without it, the local files are written in turn, synchronously, exactly as `writeModule` writes each one.
 */
export function writeModules(definition, slug, modules, options = {}) {
  const texts = Object.entries(modules).map(([moduleId, data]) => {
    const moduleSpec = definition.modules.get(moduleId)
    if (!moduleSpec) {
      throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
    }
    return { moduleId, text: renderModuleInstanceFile(moduleId, moduleSpec, data) }
  })
  const moduleIds = texts.map((t) => t.moduleId)

  if (options.azureDevOps) {
    const { client, branch } = azureDevOpsClientFor(options)
    const files = texts.map(({ moduleId, text }) => ({ path: azureDevOpsModulePath(slug, moduleId), content: text }))
    return client
      .writeFiles(files, { branch, message: options.message ?? `Update modules ${moduleIds.join(', ')}` })
      .then(({ push }) => ({ modules: moduleIds, commit: push?.commits?.[0]?.commitId ?? null }))
  }

  const instancesDir = options.instancesDir ?? 'instances'
  for (const { moduleId, text } of texts) {
    storage.writeText(modulePath(instancesDir, slug, moduleId), text)
  }
  return { modules: moduleIds }
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
